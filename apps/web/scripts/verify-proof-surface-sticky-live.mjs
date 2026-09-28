// story #4125(라이브 실측, 페드루 PO 2026-09-21) AC2 — «실 브라우저» 양성대조.
//
// 전체 앱(인증·DB·라우팅)을 안 띄우고, gates/[id]/page.tsx 우 열(gate-detail-action-column,
// #4121)과 정확히 같은 클래스 조합을 가진 최소 DOM을 `next build`가 방금 컴파일한 실
// globals.css(.next/static/css/*.css, `.proof-surface`가 들어있는 청크) 그대로 로드해
// 실 Chromium(Playwright)으로 computed style·스크롤 뒤 위치를 잰다 — 앱 전체를 안 띄워도
// 「Tailwind v4가 실제로 컴파일한 산출물에서 .proof-surface가 lg:sticky를 더 이상
// 안 이기는가」라는 이 스토리의 핵심 질문에 실 브라우저로 답한다.
//
// 실행: `pnpm build`(루트, 이 청크를 먼저 컴파일) → `node apps/web/scripts/verify-proof-surface-sticky-live.mjs`
// (apps/web 안에서 실행 — @playwright/test 로컬 node_modules 필요).
//
// 재현(음성대조, story #4125 원 실사고): `git show origin/develop:apps/web/src/app/
// globals.css`로 되돌려 같은 순서로 재실행하면 position=relative·스크롤 400px 뒤
// top이 68→-332(내용과 같이 밀림)로 재현된다 — PR 본문에 그 실측값을 그대로 적었다.

import { chromium } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findCompiledCssWithProofSurface() {
  const cssDir = path.resolve(WEB_ROOT, '.next/static/css');
  const files = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  for (const f of files) {
    const content = readFileSync(path.join(cssDir, f), 'utf8');
    if (content.includes('.proof-surface{') || content.includes('.proof-surface {')) return content;
  }
  throw new Error(`.next/static/css/*.css 중 .proof-surface 포함 청크를 못 찾음(files: ${files.join(', ')}) — 'pnpm build' 선행 필요.`);
}

const css = findCompiledCssWithProofSurface();
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}${css}</style></head>
<body>
  <div style="height:2000px">
    <div class="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5 lg:max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
      <div style="background:#eee;height:1500px;padding:8px">좌 열(스크롤 대상)</div>
      <div data-testid="gate-detail-action-column" class="proof-surface proof-surface-lift mt-3 space-y-3 border border-proof-line bg-proof-panel p-4 lg:mt-0 lg:sticky lg:top-12 lg:self-start" style="background:#fff">우 열(sticky 승인 패널)</div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
await page.setContent(html);

const action = page.getByTestId('gate-detail-action-column');
const position = await action.evaluate((el) => getComputedStyle(el).position);
const topBefore = await action.evaluate((el) => el.getBoundingClientRect().top);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(150);
const topAfter = await action.evaluate((el) => el.getBoundingClientRect().top);

console.log(`computed position: ${position}`);
console.log(`top before 400px scroll: ${topBefore}`);
console.log(`top after 400px scroll: ${topAfter}`);

const pass = position === 'sticky' && topAfter > topBefore - 50 && topAfter < 60;
console.log(pass ? 'PASS — sticky, top offset held (48px 근처)' : 'FAIL — position/top이 예상과 다름(#4125 회귀)');
await browser.close();
process.exit(pass ? 0 : 1);
