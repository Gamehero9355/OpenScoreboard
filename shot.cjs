const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_DIR = path.join(process.env.USERPROFILE, '.cache', 'puppeteer', 'chrome');
function findChrome() {
  const root = CHROME_DIR;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'chrome.exe') return full;
    }
  }
  throw new Error('chrome.exe not found under ' + root);
}

const TARGETS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3] || 'C:/Users/Philipp/AppData/Local/Temp/opencode/shots';
const TOKEN = process.argv[4];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  });

  for (const t of TARGETS) {
    const page = await browser.newPage();
    await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((token) => {
      window.localStorage.setItem('scoreboard.token', token);
    }, TOKEN);
    await page.goto(t.url, { waitUntil: 'networkidle0', timeout: 45000 });
    if (t.theme) {
      // The app writes data-theme from server settings; force it for the shot.
      await page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
      }, t.theme);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const file = path.join(OUT, t.name + '.png');
    await page.screenshot({ path: file, fullPage: !!t.full });
    console.log('shot', file);
    await page.close();
  }
  await browser.close();
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
