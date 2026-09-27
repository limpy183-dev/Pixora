// Headless test harness (uses the installed Microsoft Edge via playwright-core).
// Usage:
//   node scripts/shot.mjs [--url http://localhost:5173/] [--out shot.png] [--w 1918 --h 1138]
//                         [--eval "js code (awaited, may return a value)"] [--eval-file file.js]
//                         [--clip x,y,w,h] [--wait 300] [--actions actions.json]
// Prints console errors/warnings and the eval result as JSON. Exit code 1 if page errors occurred.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const url = opt('url', 'http://localhost:5173/');
const out = opt('out', null);
const W = +opt('w', 1918), H = +opt('h', 1138);
const evalCode = opt('eval-file', null) ? fs.readFileSync(opt('eval-file'), 'utf8') : opt('eval', null);
const clip = opt('clip', null);
const wait = +opt('wait', 250);
const exe = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
let pageErrors = 0;
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => { pageErrors++; logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__pixoraReady === true, null, { timeout: 30000 }).catch(() => logs.push('[harness] app did not become ready in 30s'));
await page.waitForTimeout(wait);
let result;
if (evalCode) {
  try {
    result = await page.evaluate(`(async () => { ${evalCode} })()`);
  } catch (e) { logs.push(`[eval-error] ${e.message}`); pageErrors++; }
  await page.waitForTimeout(wait);
}
if (out) {
  const o = { path: out };
  if (clip) { const [x, y, w, h] = clip.split(',').map(Number); o.clip = { x, y, width: w, height: h }; }
  await page.screenshot(o);
}
console.log(JSON.stringify({ result, logs }, null, 2));
await browser.close();
process.exit(pageErrors ? 1 : 0);
