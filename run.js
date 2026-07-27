const puppeteer = require("puppeteer");
const fs = require("fs");

const TARGET_URL = "https://v2.auth.mistral.ai/login";

// EduMails temporary student-email API.
const API_BASE = "https://api.edu-mails.com/api";

// ---- helpers -------------------------------------------------------------

// Random integer in [min, max] (inclusive) - used for human-like waits.
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Promise-based sleep.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Artificial "human" pause with a randomized duration.
const humanPause = (min = 400, max = 1200) => sleep(rand(min, max));

// The email field has a dynamic id, so we match on stable attributes instead.
const EMAIL_SELECTOR =
	'input[name="email"], input[inputmode="email"], input[autocomplete="username"]';

// Password to use on signup.
const PASSWORD = "Zahid456@@5";

// Random person-name pools for the first/last name fields.
const FIRST_NAMES = [
	"James", "Olivia", "Liam", "Emma", "Noah", "Ava", "William", "Sophia",
	"Benjamin", "Isabella", "Lucas", "Mia", "Henry", "Charlotte", "Alexander",
	"Amelia", "Daniel", "Harper", "Michael", "Evelyn", "Ethan", "Abigail",
];
const LAST_NAMES = [
	"Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
	"Davis", "Rodriguez", "Martinez", "Wilson", "Anderson", "Taylor", "Thomas",
	"Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark",
];

// Pick a random element from an array.
const pick = (arr) => arr[rand(0, arr.length - 1)];

// Direct input into a field: sets native value, dispatches input/change events directly.
async function directInput(page, selector, text) {
	await page.evaluate((sel, val) => {
		const el = document.querySelector(sel);
		if (el) {
			el.focus();
			const nativeSetter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value"
			)?.set;
			if (nativeSetter) {
				nativeSetter.call(el, val);
			} else {
				el.value = val;
			}
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}, selector, text);
}

// Fast input wrapper for backwards compatibility
async function humanType(page, selector, text) {
	await directInput(page, selector, text);
}

// Helper to assemble all text content from an API message object.
function getMessageText(m) {
	if (!m) return "";
	if (typeof m === "string") return m;
	const parts = [
		m.subject,
		m.body,
		m.html,
		m.text,
		m.content,
		m.text_body,
		m.html_body,
		m.body_html,
		m.body_text,
		JSON.stringify(m),
	];
	return parts.filter(Boolean).join("\n");
}

// Extract 6-digit OTP code from email messages.
function extractOtp(messages) {
	for (const m of messages) {
		const haystack = getMessageText(m);
		const codeParamMatch = haystack.match(/code=(\d{6})/i);
		if (codeParamMatch) return codeParamMatch[1];

		const htmlMatch = haystack.match(/>(\d{6})</);
		if (htmlMatch) return htmlMatch[1];

		const standaloneMatch = haystack.match(/(?<!\d)\d{6}(?!\d)/);
		if (standaloneMatch) return standaloneMatch[0];
	}
	return null;
}

// Extract direct verification link from email messages.
function extractVerificationLink(messages) {
	for (const m of messages) {
		const haystack = getMessageText(m);
		const match = haystack.match(/https?:\/\/[^\s"'<>]*self-service\/verification[^\s"'<>]+/i);
		if (match) {
			return match[0].replace(/&amp;/g, "&");
		}
	}
	return null;
}

// ---- EduMails API --------------------------------------------------------

// Generate a temporary edu email.
async function generateEduEmail({ alias, domainId } = {}) {
	const body =
		alias && domainId
			? { action: "custom", alias, domain_id: domainId }
			: { action: "random" };

	const res = await fetch(`${API_BASE}/emails/generate`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`Email generation failed: HTTP ${res.status}`);
	}

	const json = await res.json();
	const email = json && json.data && json.data.email;
	if (!email || !email.address) {
		throw new Error(
			"Unexpected API response: " + JSON.stringify(json).slice(0, 300)
		);
	}

	return { address: email.address, uuid: email.uuid };
}

// Fetch the inbox for a given email UUID.
async function fetchInbox(uuid) {
	const res = await fetch(`${API_BASE}/emails/${uuid}`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`Inbox fetch failed: HTTP ${res.status}`);
	}
	const json = await res.json();
	return (json && json.data && json.data.messages) || [];
}

// Poll the inbox until at least one message arrives (or we time out).
async function waitForMessages(uuid, { timeout = 120000, interval = 5000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const messages = await fetchInbox(uuid);
			if (messages.length > 0) return messages;
		} catch (e) {
			console.warn("  (inbox poll error, retrying)", e.message);
		}
		await sleep(interval);
	}
	return [];
}

// ---- Single Account Worker Automation Routine -----------------------------

async function runSingleAccountAutomation(workerId, accountNum, { alias, domainId, isCI, keepOpen }) {
	const logPrefix = `[Worker #${workerId} | Account #${accountNum}]`;
	let browser;

	try {
		console.log(`${logPrefix} Requesting a temporary edu email...`);
		const { address: EMAIL, uuid } = await generateEduEmail({ alias, domainId });
		console.log(`${logPrefix} Generated email: ${EMAIL} (UUID: ${uuid})`);

		console.log(`${logPrefix} Launching browser...`);
		browser = await puppeteer.launch({
			headless: isCI ? true : false,
			defaultViewport: isCI ? { width: 1920, height: 1080 } : null,
			args: [
				"--start-maximized",
				"--disable-blink-features=AutomationControlled",
				"--no-default-browser-check",
				"--no-first-run",
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
			],
		});

		const page = await browser.newPage();
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
		);
		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, "webdriver", { get: () => undefined });
		});

		console.log(`${logPrefix} Navigating to ${TARGET_URL} ...`);
		await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

		console.log(`${logPrefix} Waiting for email field...`);
		await page.waitForSelector(EMAIL_SELECTOR, { visible: true, timeout: 30000 });
		await page.waitForFunction(
			(sel) => {
				const el = document.querySelector(sel);
				return el && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.offsetParent !== null;
			},
			{ timeout: 30000 },
			EMAIL_SELECTOR
		);

		console.log(`${logPrefix} Entering email: ${EMAIL}`);
		await directInput(page, EMAIL_SELECTOR, EMAIL);
		await humanPause(200, 500);

		console.log(`${logPrefix} Waiting for Continue button...`);
		await page.waitForFunction(
			() => {
				const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
				return btns.some((b) => {
					const label = (b.textContent || "").trim().toLowerCase();
					return label === "continue" && b.offsetParent !== null && !b.disabled && b.getAttribute("aria-disabled") !== "true";
				});
			},
			{ timeout: 30000 }
		);

		await humanPause(400, 800);
		const continueBtn = await page.evaluateHandle(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "continue");
		});
		const btnEl = continueBtn.asElement();
		if (btnEl) await btnEl.click();
		else await page.keyboard.press("Enter");

		const PASSWORD_SELECTOR = 'input[name="password"]';
		const FIRST_NAME_SELECTOR = 'input[name="firstName"]';
		const LAST_NAME_SELECTOR = 'input[name="lastName"]';

		console.log(`${logPrefix} Waiting for signup form fields...`);
		await page.waitForSelector(PASSWORD_SELECTOR, { visible: true, timeout: 30000 });
		await page.waitForSelector(FIRST_NAME_SELECTOR, { visible: true, timeout: 30000 });
		await page.waitForSelector(LAST_NAME_SELECTOR, { visible: true, timeout: 30000 });

		const firstName = pick(FIRST_NAMES);
		const lastName = pick(LAST_NAMES);
		console.log(`${logPrefix} Using name: ${firstName} ${lastName}`);

		await directInput(page, PASSWORD_SELECTOR, PASSWORD);
		await directInput(page, FIRST_NAME_SELECTOR, firstName);
		await directInput(page, LAST_NAME_SELECTOR, lastName);
		await humanPause(300, 600);

		console.log(`${logPrefix} Clicking Signup button...`);
		await page.waitForFunction(
			() => {
				const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
				return btns.some((b) => {
					const label = (b.textContent || "").trim().toLowerCase();
					return label === "signup" && b.offsetParent !== null && !b.disabled && b.getAttribute("aria-disabled") !== "true";
				});
			},
			{ timeout: 30000 }
		);

		const signupBtn = await page.evaluateHandle(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "signup");
		});
		const signupEl = signupBtn.asElement();
		if (signupEl) await signupEl.click();

		const OTP_SELECTOR = 'input[data-input-otp="true"], input[autocomplete="one-time-code"]';
		console.log(`${logPrefix} Waiting for OTP screen or verification email...`);
		try {
			await page.waitForSelector(OTP_SELECTOR, { visible: true, timeout: 15000 });
		} catch (e) {}

		console.log(`${logPrefix} Polling inbox for verification code/link...`);
		const messages = await waitForMessages(uuid, { timeout: 120000, interval: 5000 });

		if (messages.length > 0) {
			const otpCode = extractOtp(messages);
			const verificationLink = extractVerificationLink(messages);

			if (otpCode) {
				console.log(`${logPrefix} Entering OTP code: ${otpCode}`);
				const focused = await page.evaluate((sel) => {
					const el = document.querySelector(sel);
					if (el) { el.focus(); el.click(); return true; }
					return false;
				}, OTP_SELECTOR);

				if (focused) {
					await directInput(page, OTP_SELECTOR, otpCode);
				}
			}

			if (verificationLink) {
				console.log(`${logPrefix} Navigating to verification link...`);
				await humanPause(500, 1000);
				await page.goto(verificationLink, { waitUntil: "networkidle2", timeout: 60000 });
			}
		}

		console.log(`${logPrefix} Ensuring navigation to https://admin.mistral.ai/ ...`);
		await humanPause(1000, 2000);
		if (!page.url().startsWith("https://admin.mistral.ai")) {
			await page.goto("https://admin.mistral.ai/", { waitUntil: "networkidle2", timeout: 60000 });
		}

		// Check if organization creation is needed or if already inside an organization
		const ORG_NAME_SELECTOR = 'input[name="name"], input[placeholder="My organization"]';
		let needsOrgCreation = false;
		try {
			await page.waitForFunction(
				(sel) => {
					const hasOrgField = !!document.querySelector(sel);
					const isApiKeysPage = window.location.href.includes("/organization/");
					return hasOrgField || isApiKeysPage;
				},
				{ timeout: 30000 },
				ORG_NAME_SELECTOR
			);
			needsOrgCreation = await page.evaluate((sel) => !!document.querySelector(sel), ORG_NAME_SELECTOR);
		} catch (e) {
			console.warn(`${logPrefix} Neither Org field nor redirect detected within 30s, attempting navigation to API keys page directly.`);
		}

		if (needsOrgCreation) {
			const UNCOMMON_ORG_NAMES = [
				"Apex Nebula Labs", "Zephyr Cybernetics", "Krypton Dynamics",
				"Vortex Synthetics", "Obsidian Quantum", "Hyperion Analytics",
				"Aetherial BioSystems", "Zenith Robotics", "Astraea Nexus",
				"Chrono Logic Systems", "Solstice Enterprise", "Eclipse Innovation"
			];
			const orgName = `${pick(UNCOMMON_ORG_NAMES)} ${rand(100, 999)}`;
			console.log(`${logPrefix} Entering organization name: ${orgName}`);
			await directInput(page, ORG_NAME_SELECTOR, orgName);

			await page.evaluate(() => {
				const termsInput = document.querySelector('input[name="terms"]');
				if (termsInput) {
					if (!termsInput.checked && termsInput.getAttribute('aria-checked') !== 'true') {
						const label = document.querySelector(`label[for="${termsInput.id}"]`) || termsInput;
						label.click();
					}
				}
			});

			await page.waitForFunction(() => {
				const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
				return btns.some((b) => {
					const label = (b.textContent || "").trim().toLowerCase();
					return label === "create organization" && b.offsetParent !== null && !b.disabled && b.getAttribute("aria-disabled") !== "true";
				});
			}, { timeout: 30000 });

			const createOrgBtnHandle = await page.evaluateHandle(() => {
				const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
				return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "create organization");
			});
			const createOrgEl = createOrgBtnHandle.asElement();
			if (createOrgEl) await createOrgEl.click();
			else await page.keyboard.press("Enter");
		} else {
			console.log(`${logPrefix} Organization already exists or skipped.`);
		}

		console.log(`${logPrefix} Navigating to API Keys page...`);
		await humanPause(1500, 3000);
		if (!page.url().includes("/organization/api-keys")) {
			await page.goto("https://admin.mistral.ai/organization/api-keys", { waitUntil: "networkidle2", timeout: 60000 });
		}

		console.log(`${logPrefix} Clicking 'New key' button...`);
		await page.waitForFunction(() => {
			const btns = Array.from(document.querySelectorAll("button"));
			return btns.some((b) => (b.textContent || "").trim().toLowerCase().includes("new key") && b.offsetParent !== null);
		}, { timeout: 30000 });

		const newKeyBtnHandle = await page.evaluateHandle(() => {
			const btns = Array.from(document.querySelectorAll("button"));
			return btns.find((b) => (b.textContent || "").trim().toLowerCase().includes("new key"));
		});
		const newKeyEl = newKeyBtnHandle.asElement();
		if (newKeyEl) await newKeyEl.click();

		console.log(`${logPrefix} Waiting for modal and selecting Workspace...`);
		await page.waitForSelector('[role="dialog"]', { visible: true, timeout: 30000 });

		const workspaceBtnHandle = await page.evaluateHandle(() => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return null;
			const labels = Array.from(dialog.querySelectorAll('label'));
			const wsLabel = labels.find(l => (l.textContent || '').trim().toLowerCase() === 'workspace');
			if (wsLabel) {
				const forId = wsLabel.getAttribute('for');
				if (forId) {
					const target = dialog.querySelector(`#${forId}`) || document.getElementById(forId);
					if (target) return target;
				}
				const parentDiv = wsLabel.closest('div');
				if (parentDiv) {
					const btn = parentDiv.querySelector('button[role="combobox"]');
					if (btn) return btn;
				}
			}
			const btns = Array.from(dialog.querySelectorAll('button[role="combobox"]'));
			return btns.find((b) => (b.textContent || "").toLowerCase().includes("select workspace")) || btns[0];
		});

		const workspaceEl = workspaceBtnHandle.asElement();
		if (workspaceEl) {
			const isOpen = await page.evaluate((el) => {
				return el.getAttribute('aria-expanded') === 'true' || el.getAttribute('data-state') === 'open';
			}, workspaceEl);
			if (!isOpen) await workspaceEl.click();
		}

		await humanPause(500, 1000);
		let selectedDefault = false;
		try {
			await page.waitForFunction(() => {
				const items = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], [cmdk-item]'));
				if (items.length > 0) return true;
				const leafs = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0);
				return leafs.some(el => (el.textContent || '').trim().toLowerCase().includes('default'));
			}, { timeout: 5000 });

			selectedDefault = await page.evaluate(() => {
				const roleItems = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], [cmdk-item]'));
				let target = roleItems.find(el => (el.textContent || "").trim().toLowerCase().includes("default"));
				if (!target) {
					const candidates = Array.from(document.querySelectorAll('div, span, button, p, li'));
					target = candidates.find(el => {
						const txt = (el.textContent || "").trim().toLowerCase();
						const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SVG');
						return isLeaf && (txt === "default" || txt === "default workspace" || txt.startsWith("default"));
					});
				}
				if (target) {
					target.scrollIntoView({ block: 'nearest' });
					target.click();
					target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
					target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
					target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					return true;
				}
				return false;
			});
		} catch (e) {}

		if (!selectedDefault) {
			await page.keyboard.press("ArrowDown");
			await sleep(200);
			await page.keyboard.press("Enter");
		}

		await humanPause(500, 1000);

		const modalSubmitBtnHandle = await page.evaluateHandle(() => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return null;
			const btns = Array.from(dialog.querySelectorAll('button[type="submit"], button'));
			return btns.find((b) => (b.textContent || "").trim().toLowerCase() === "new key" && b.offsetParent !== null);
		});
		const modalSubmitEl = modalSubmitBtnHandle.asElement();
		if (modalSubmitEl) await modalSubmitEl.click();
		else {
			await page.evaluate(() => {
				const dialog = document.querySelector('[role="dialog"]');
				const form = dialog ? dialog.querySelector("form") : null;
				if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
			});
		}

		console.log(`${logPrefix} Waiting for API key created modal...`);
		await page.waitForFunction(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			return dialogs.some(d => (d.textContent || "").toLowerCase().includes("api key created") || d.querySelector('input[readonly]'));
		}, { timeout: 30000 });

		const apiKey = await page.evaluate(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			const targetDialog = dialogs.find(d => (d.textContent || "").toLowerCase().includes("api key created")) || dialogs[dialogs.length - 1];
			if (!targetDialog) return null;
			const input = targetDialog.querySelector('input[readonly], input[value]');
			return input && input.value ? input.value.trim() : null;
		});

		if (apiKey) {
			console.log(`\n${logPrefix} SUCCESS! Generated API Key: ${apiKey}`);
			fs.appendFileSync("api_keys.txt", `${apiKey}\n`, "utf-8");
			console.log(`${logPrefix} API Key saved to api_keys.txt`);
		} else {
			throw new Error("Failed to extract API key from modal input.");
		}

		await page.evaluate(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			const targetDialog = dialogs.find(d => (d.textContent || "").toLowerCase().includes("api key created")) || dialogs[dialogs.length - 1];
			if (targetDialog) {
				const btns = Array.from(targetDialog.querySelectorAll('button'));
				const doneBtn = btns.find(b => (b.textContent || "").trim().toLowerCase() === "done");
				if (doneBtn) doneBtn.click();
			}
		});

	} finally {
		if (browser && !keepOpen) {
			console.log(`${logPrefix} Closing browser instance...`);
			await browser.close().catch(() => {});
		}
	}
}

// ---- Concurrent Worker Pool Entry Point ------------------------------------

(async () => {
	const cliCountArg = process.argv[2];
	const cliWorkersArg = process.argv[3];
	const cliAlias = process.argv[4];
	const cliDomainId = process.argv[5] ? parseInt(process.argv[5], 10) : undefined;

	let totalAccounts = parseInt(process.env.COUNT || cliCountArg || "1", 10);
	if (isNaN(totalAccounts) || totalAccounts < 1) totalAccounts = 1;

	let maxWorkers = parseInt(process.env.WORKERS || cliWorkersArg || "1", 10);
	if (isNaN(maxWorkers) || maxWorkers < 1) maxWorkers = 1;

	const effectiveWorkers = Math.min(maxWorkers, totalAccounts);
	const isCI = !!process.env.CI;

	console.log(`==================================================`);
	console.log(`Mistral API Key Generator (Multi-Worker Pool)`);
	console.log(`Target Accounts      : ${totalAccounts}`);
	console.log(`Parallel Workers     : ${effectiveWorkers}`);
	console.log(`Environment          : ${isCI ? "CI (Headless)" : "Local"}`);
	console.log(`==================================================\n`);

	let nextAccountIndex = 0;
	let successCount = 0;
	let failureCount = 0;

	async function workerLoop(workerId) {
		while (true) {
			if (nextAccountIndex >= totalAccounts) break;
			const taskIndex = ++nextAccountIndex;

			const keepOpen = (totalAccounts === 1 && !isCI);

			try {
				await runSingleAccountAutomation(workerId, taskIndex, {
					alias: cliAlias,
					domainId: cliDomainId,
					isCI,
					keepOpen,
				});
				successCount++;
			} catch (err) {
				failureCount++;
				console.error(`[Worker #${workerId} | Account #${taskIndex}] Error: ${err.message}`);
			}
		}
	}

	const workerPromises = [];
	for (let w = 1; w <= effectiveWorkers; w++) {
		workerPromises.push(workerLoop(w));
	}

	await Promise.all(workerPromises);

	console.log(`\n==================================================`);
	console.log(`SUMMARY: All Account Tasks Finished`);
	console.log(`Total Target Accounts : ${totalAccounts}`);
	console.log(`Successful           : ${successCount}`);
	console.log(`Failed               : ${failureCount}`);
	console.log(`Saved File           : api_keys.txt`);
	console.log(`==================================================\n`);

	process.exit(failureCount === totalAccounts ? 1 : 0);
})();
