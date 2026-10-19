// Renders the README images into docs/readme/: the GinBench charts from data.json, in light and dark, plus the wordmark,
// the feature strip and the framed app screenshot. Uses the app's Playwright and its bundled fonts (Geist, Newsreader:
// SIL Open Font License), so run `npm install` in contract-review/ first.
// Usage (from the folder holding contract-review/ and tough-eval/): node tough-eval/v2/charts/render.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from './charts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'contract-review');
const OUT = path.join(ROOT, 'docs', 'readme');
const require = createRequire(path.join(APP, 'package.json'));
const { chromium } = require('playwright');

const data = JSON.parse(readFileSync(path.join(HERE, 'data.json'), 'utf8'));
const font = (family, file, weight) => `@font-face{font-family:${family};font-weight:${weight};src:url('${pathToFileURL(path.join(APP, 'node_modules/@fontsource', file)).href}') format('woff2')}`;
const fontsCss = [
  font('Geist', 'geist/files/geist-latin-400-normal.woff2', 400),
  font('Geist', 'geist/files/geist-latin-500-normal.woff2', 500),
  font('Geist', 'geist/files/geist-latin-600-normal.woff2', 600),
  font('Newsreader', 'newsreader/files/newsreader-latin-400-normal.woff2', 400),
].join('\n');
const shot = name => pathToFileURL(path.join(APP, 'docs/screenshots', name)).href;
const shots = { review: shot('01-review.png'), playbook: shot('08-playbook.png'), document: shot('04-document.png') };

const jobs = [];
for (const theme of ['light', 'dark']) {
  jobs.push([`fully-right-by-cost-${theme}`, theme, C.fullyRightByCost(data)]);
  jobs.push([`caught-vs-false-alarms-${theme}`, theme, C.caughtVsFalseAlarms(data)]);
  jobs.push([`scorecard-${theme}`, theme, C.scorecard(data)]);
  jobs.push([`cost-and-time-${theme}`, theme, C.costAndTime(data)]);
  jobs.push([`own-items-${theme}`, theme, C.ownItems(data, theme)]);
  jobs.push([`wordmark-${theme}`, theme, C.wordmark()]);
  jobs.push([`features-${theme}`, theme, C.features(shots)]);
}
jobs.push(['app-review', 'light', C.framedShot(shots.review)]);

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ginbench-charts-'));
const browser = await chromium.launch();
try {
  for (const [name, theme, body] of jobs) {
    const scale = name === 'app-review' ? 1 : 2;
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 1600, height: 1200 } });
    const file = path.join(tmp, `${name}.html`);
    writeFileSync(file, C.page(theme, fontsCss, body));
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#chart').screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
    await page.close();
    console.log(`docs/readme/${name}.png`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
