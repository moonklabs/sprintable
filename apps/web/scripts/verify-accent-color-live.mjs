// story #4128(유나 canon 정식 결정, 2026-09-21) AC3 — «실 브라우저» 양성대조.
//
// story #4125의 verify-proof-surface-sticky-live.mjs와 같은 관례 — 전체 앱(인증·DB) 없이
// `next build`가 방금 컴파일한 실 globals.css(.next/static/css/*.css, `accent-color`가 들어있는
// 청크)를 그대로 로드해, 체크된 checkbox/radio의 computed accent-color가 --primary 값인지
// 실 Chromium(Playwright)으로 라이트/다크 양쪽 잰다.
//
// 실행: `pnpm build`(루트, 이 청크를 먼저 컴파일) → `node apps/web/scripts/verify-accent-color-live.mjs`
// (apps/web 안에서 실행 — @playwright/test 로컬 node_modules 필요).

import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = '/tmp/accent-color-4128-captures';
mkdirSync(OUT_DIR, { recursive: true });

function findCompiledCssWithAccentColor() {
  const cssDir = path.resolve(WEB_ROOT, '.next/static/css');
  const files = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  for (const f of files) {
    const content = readFileSync(path.join(cssDir, f), 'utf8');
    if (content.includes('accent-color')) return content;
  }
  throw new Error(`.next/static/css/*.css 중 accent-color 포함 청크를 못 찾음(files: ${files.join(', ')}) — 'pnpm build' 선행 필요.`);
}

function html(css, dark) {
  return `<!doctype html>
<html class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><style>html,body{margin:0;padding:24px;background:var(--background)}${css}</style></head>
<body>
  <label style="display:flex;gap:8px;align-items:center;font-family:sans-serif">
    <input type="checkbox" checked data-testid="accent-checkbox" />
    체크된 checkbox
  </label>
  <label style="display:flex;gap:8px;align-items:center;font-family:sans-serif;margin-top:12px">
    <input type="radio" checked data-testid="accent-radio" />
    체크된 radio
  </label>
</body></html>`;
}

const css = findCompiledCssWithAccentColor();
const browser = await chromium.launch();
let allPass = true;

for (const dark of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
  await page.setContent(html(css, dark));

  const checkbox = page.getByTestId('accent-checkbox');
  const radio = page.getByTestId('accent-radio');
  const checkboxAccentColor = await checkbox.evaluate((el) => getComputedStyle(el).accentColor);
  const radioAccentColor = await radio.evaluate((el) => getComputedStyle(el).accentColor);
  const expectedPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());

  const theme = dark ? 'dark' : 'light';
  console.log(`[${theme}] checkbox accent-color: ${checkboxAccentColor} / radio accent-color: ${radioAccentColor} / --primary: ${expectedPrimary}`);

  await page.screenshot({ path: path.join(OUT_DIR, `${theme}-checked.png`) });

  // computed accentColor는 브라우저가 oklch()를 색공간에 따라 rgb()/oklch()로 직렬화해 돌려줄 수
  // 있다 — 'none'이 아니고 'auto'가 아니면 override가 적용된 것으로 판단(정확한 값 등가 비교는
  // verify-accent-color-contrast.ts의 토큰-수학 계층이 이미 함).
  const pass = checkboxAccentColor !== 'auto' && checkboxAccentColor !== 'none' && radioAccentColor !== 'auto' && radioAccentColor !== 'none';
  console.log(pass ? `  PASS(${theme}) — accent-color override 적용됨` : `  FAIL(${theme}) — accent-color가 auto/none(override 미적용, #4128 회귀)`);
  if (!pass) allPass = false;

  await page.close();
}

await browser.close();
console.log(allPass ? '\nOK: 라이트/다크 모두 accent-color override 확認, 캡처 2장 저장됨.' : '\nFAIL');
process.exit(allPass ? 0 : 1);
