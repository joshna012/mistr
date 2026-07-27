# Mistral Login Opener

Opens https://v2.auth.mistral.ai/login in a visible (non-headless) Chrome browser using Puppeteer.

## Setup (run once)

```bash
npm install
```

## Run

```bash
node run.js
```

The browser window opens maximized and stays open until you close it manually. The script then exits cleanly.

## If the site blocks the automated browser

Install stealth mode:

```bash
npm install puppeteer-extra puppeteer-extra-plugin-stealth
```

Then replace the first line of `run.js` with:

```js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
```

The rest of the code stays the same.
