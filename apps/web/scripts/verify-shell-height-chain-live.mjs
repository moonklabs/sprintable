// story #4130 — 실 셸 부모 사슬(SidebarProvider h-svh → SidebarInset → :199 스크롤러 →
// ContextualPanelLayout grid/content) 포함 DOM으로, min-h-0 제거가 (A) gates/[id]류(자체
// overflow-y-auto 없음, position:sticky 대상)와 (B~E) retro/sprints/docs류(자체 내부
// 스크롤러 보유)에 각각 어떻게 작동하는지 실측한다 — #4125 스크립트와 같은 관례(next build
// 컴파일 CSS 그대로 로드, chromium.launch() 직접 사용).
//
// ⚠️실측 함정(자기 자신 재현) — 내부 리스트를 `<div style="height:2000px">` 단일 인라인
// 높이로 흉내내면, 그 div가 (overflow-y-auto 컨테이너의) flex 자식일 때 flex-shrink:1
// 기본값이 실제 content-driven 최소 높이(거의 0, 텍스트 한 줄) 밑으로 짓눌러버려 "스크롤 안
// 생김"을 관측하게 된다 — 이건 테스트 픽스처의 인공물이지 실 코드 버그가 아니다(실 리스트는
// 요소 여러 개가 쌓여 진짜 min-content 높이가 크다). manyItems()로 실제 스택형 콘텐츠를
// 흉내내 이 함정을 피한다.
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findCompiledCss() {
  const cssDir = path.resolve(WEB_ROOT, '.next/static/css');
  const files = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
  let combined = '';
  for (const f of files) combined += readFileSync(path.join(cssDir, f), 'utf8') + '\n';
  return combined;
}

function manyItems(n, bg) {
  return Array.from({ length: n }, (_, i) => `<div style="padding:20px;border-bottom:1px solid #ccc;background:${bg}">item ${i}</div>`).join('');
}

// story #4130 CHANGES-1(까디르군 렌즈 (b) 재현 실패 지적, 2026-09-22) — 원래 (A) 픽스처는
// gate-detail-container에 인라인 `height:1400px`를 줘서, 셸 wrapper에 min-h-0를 되돌려도
// sticky가 그대로 성립해버렸다(explicit height가 flex-basis를 직접 제공해 ancestor의
// min-h-0 유무와 무관해짐 — "min-h-0 제거가 근본"이라는 이 PR의 핵심 주장을 못 틀리는
// 대조로 증명 못 함). 고침: (1) gate-detail-container는 실 파일과 동일하게 explicit height
// 0(내용이 스택형 아이템으로 자연스럽게 길어짐 — min-content 기반 성장, 인라인 height 아님)
// (2) 셸 wrapper의 className/contentClassName을 실 dashboard-shell.tsx 소스에서 정규식으로
// 그대로 추출(BEFORE_CLASSNAME/BEFORE_CONTENT_CLASSNAME은 git diff로 고정한 실측 이전 값) —
// 소스를 되돌리면 이 스크립트의 "AFTER"도 자동으로 옛 값을 읽어 RED가 된다.
const DASHBOARD_SHELL_SRC = readFileSync(
  path.resolve(WEB_ROOT, 'src/app/dashboard/dashboard-shell.tsx'),
  'utf-8',
);
const CURRENT_CLASSNAME = /className="(min-h-0 flex-1|flex-1)"\s*\n\s*inlineColumnsClassName/.exec(DASHBOARD_SHELL_SRC)?.[1];
const CURRENT_CONTENT_CLASSNAME = /'(flex min-h-0 min-w-0 flex-col[^']*|flex min-w-0 flex-col[^']*)'/.exec(DASHBOARD_SHELL_SRC)?.[1];
if (!CURRENT_CLASSNAME || !CURRENT_CONTENT_CLASSNAME) {
  throw new Error('dashboard-shell.tsx에서 ContextualPanelLayout className/contentClassName을 못 찾음 — 정규식이 소스 변경을 못 따라간 것, 스크립트를 갱신할 자리.');
}
// story #4130 착지 前(git diff로 고정한 실측값, origin/develop f3036d10e 계열) — #4125까지
// 착지된 상태의 실제 값. 이 파일이 이 스토리 착지 後 develop에 병합되면 이 두 상수는 "역사적
// 음성대조 고정값"으로만 남는다(CURRENT_*가 이미 고쳐진 값을 읽으므로).
const BEFORE_CLASSNAME = 'min-h-0 flex-1';
const BEFORE_CONTENT_CLASSNAME = 'flex min-h-0 min-w-0 flex-col 2xl:col-start-1 2xl:row-start-1';

// story #4131 AC4 — topbarHidden(showTopBar=false, /settings와 같은 라우트)이면 TopBar
// div 자체가 안 그려지고(실 dashboard-shell.tsx:200 `{showTopBar && (...)}`와 동형)
// SidebarProvider(.dashboard-shell-root)에 `data-topbar-hidden`이 실려 --shell-chrome-h가
// 0으로 떨어진다. viewportWidth로 lg(1024px) 위/아래를 호출부가 골라 모바일 탭바 분기를
// 재현한다(뷰포트 폭 자체가 CSS 미디어쿼리를 트리거 — 별도 JS 분기 불요).
function shellHtml(innerContent, { className, contentClassName, topbarHidden = false }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${findCompiledCss()}</style></head>
<body>
  <div class="h-svh dashboard-shell-root flex w-full" ${topbarHidden ? 'data-topbar-hidden' : ''}>
    <main class="relative flex w-full flex-1 flex-col overflow-hidden">
      <div id="scroller" class="flex flex-1 min-h-0 flex-col overflow-y-auto">
        ${topbarHidden ? '' : '<div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">TopBar(48px)</div>'}
        <div class="grid gap-4 grid-cols-1 ${className}">
          <div class="${contentClassName}">
            ${innerContent}
          </div>
        </div>
      </div>
    </main>
  </div>
</body></html>`;
}

// 실 gates/[id]/page.tsx:344 클래스 그대로(explicit height 없음 — min-h-full은 최소치일
// 뿐 내용이 그보다 길면 자연히 더 자란다). 좌 열은 manyItems()로 진짜 스택형 콘텐츠(실
// min-content 성장) — 인라인 height 트릭 안 씀(위 CHANGES-1 교훈).
// story #4130 CHANGES-2(페드루 PO 재지적, 2026-09-22 00:17Z) — 빠진 조각: sticky는 포함
// 블록 안에서 "움직일 거리"가 있어야 움직인다. 라이브는 액션 패널(512px) ≥ 캡된 컨테이너
// (496px)라 그 거리가 0(패널이 컨테이너보다 크면 sticky는 자기 static 위치에 그대로 있다 —
// 이것 자체가 "내용과 같이 밀리는" 것처럼 보인다). 원래 fixture는 액션 패널이 짧아(우 열
// 텍스트 한 줄) 캡된 컨테이너 안에서도 움직일 거리가 남아 있었다 — 그래서 BEFORE에서도
// sticky가 "작동하는 것처럼" 보였다. 액션 패널을 실측처럼 ≥512px로 채워 이 거리를 0으로
// 만든다.
function gatesLikeHtml() {
  return `
  <div data-testid="gate-detail-container" class="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5 lg:max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
    <div>${manyItems(40, '#eee')}</div>
    <div data-testid="action-column" class="proof-surface mt-3 space-y-3 border p-4 lg:mt-0 lg:sticky lg:top-12 lg:self-start" style="background:#fff">${manyItems(20, '#fff')}</div>
  </div>
`;
}

const browser = await chromium.launch();
let allPass = true;

// (A) gates/[id]류 — sticky가 :scroller를 포함 블록으로 잡아 스크롤 뒤에도 top 고정돼야
// 한다. AFTER(실 소스에서 읽은 현재 클래스)와 BEFORE(#4130 착지 前 고정값) 둘 다 돌려
// 나란히 비교 — "min-h-0 제거가 근본"이라는 주장을 못 틀리는 대조로 증명한다.
async function runGatesScenario(label, wrapperClasses) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(gatesLikeHtml(), wrapperClasses));
  const container = page.getByTestId('gate-detail-container');
  const action = page.getByTestId('action-column');
  const scroller = page.locator('#scroller');

  const containerClientH = await container.evaluate((el) => el.clientHeight);
  const containerScrollH = await container.evaluate((el) => el.scrollHeight);
  const actionOffsetH = await action.evaluate((el) => el.offsetHeight);
  const position = await action.evaluate((el) => getComputedStyle(el).position);
  const topBefore = await action.evaluate((el) => el.getBoundingClientRect().top);
  // story #4130 CHANGES-2 — Pedro의 정확한 재현(스크롤 200px)과 같은 거리로 잰다.
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(100);
  const topAfter = await action.evaluate((el) => el.getBoundingClientRect().top);
  const scrollerScrollTop = await scroller.evaluate((el) => el.scrollTop);
  await page.close();

  return { label, containerClientH, containerScrollH, actionOffsetH, position, topBefore, topAfter, scrollerScrollTop };
}

{
  const after = await runGatesScenario('AFTER(실 소스 현재값)', { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME });
  const before = await runGatesScenario('BEFORE(#4130 착지 前 고정값)', { className: BEFORE_CLASSNAME, contentClassName: BEFORE_CONTENT_CLASSNAME });

  for (const r of [before, after]) {
    console.log(`(A-${r.label}) container clientH=${r.containerClientH}/scrollH=${r.containerScrollH} · action panel H=${r.actionOffsetH}(≥ 캡 높이일 때만 "움직일 거리 0" 재현) · position=${r.position} · top ${r.topBefore.toFixed(1)}→${r.topAfter.toFixed(1)}(스크롤 200px 뒤) · #scroller.scrollTop=${r.scrollerScrollTop}`);
  }

  // 핵심 기계적 주장(이 카드의 AC1) — AFTER: 컨테이너 박스가 내용 높이만큼 자란다
  // (clientH≈scrollH). BEFORE: 컨테이너가 스크롤러 가용폭에 캡된다(clientH<scrollH,
  // Pedro 라이브 실측 496/1422와 같은 모양).
  const afterGrew = after.containerClientH >= after.containerScrollH - 2;
  const beforeCapped = before.containerClientH < before.containerScrollH - 2;
  const containerClaim = afterGrew && beforeCapped;

  // story #4130 CHANGES-2(페드루 PO, 2026-09-22 00:17Z) — 빠졌던 조각: sticky는 포함 블록
  // 안에서 "움직일 거리"가 있어야 움직인다. 액션 패널(actionOffsetH) ≥ 캡된 컨테이너
  // (containerClientH)면 그 거리가 0 — sticky가 자기 static 위치에 그대로 있는 것 자체가
  // "스크롤과 같이 밀리는" 라이브 증상과 같다(움직이는 게 아니라 애초에 안 움직인 것).
  // BEFORE: top이 스크롤 거리(200px)만큼 그대로 줄어야(추종 0, 내용과 같이 밀림).
  // AFTER: top이 48px에 고정돼야(포함 블록이 :scroller까지 자라 움직일 거리가 충분).
  const beforePanelDominates = before.actionOffsetH >= before.containerClientH;
  const beforeFollowsContent = Math.abs((before.topBefore - 200) - before.topAfter) < 3; // 스크롤량만큼 그대로 밀림
  const afterSticks = after.position === 'sticky' && after.topAfter < 60 && after.topAfter >= 40;

  const pass = containerClaim && beforePanelDominates && beforeFollowsContent && afterSticks;
  console.log(`(A) 판정 — 컨테이너 성장(AC1) AFTER 자람? ${afterGrew} · BEFORE 캡? ${beforeCapped} · BEFORE 패널이 캡보다 큼(움직일거리 0 성립조건)? ${beforePanelDominates} · BEFORE 내용과 같이 밀림(추종 0, 라이브 증상 재현)? ${beforeFollowsContent} · AFTER 48px 고정(정상 추종)? ${afterSticks} : ${pass ? 'PASS(못 틀리는 대조 완성)' : 'FAIL — CHANGES-2 재발'}`);
  if (!pass) allPass = false;
}

// (B) retro류(#4130 픽스 前 — 음성대조) — 로컬 스크롤 경계(min-h-0 flex-1)만 있고 뷰포트
//     앵커가 없으면 내부 스크롤러가 outer #scroller 성장에 흡수돼 풀린다(실사고 재현).
const RETRO_UNFIXED = `
  <div class="px-6 pt-3" style="flex-shrink:0">고정 툴바(WorkspaceFrameTabs류)</div>
  <div data-testid="inner-scroller" class="focus-inset flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto">
    ${manyItems(60, '#dde')}
  </div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(RETRO_UNFIXED, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const inner = page.getByTestId('inner-scroller');
  const scroller = page.locator('#scroller');
  const innerClientHeight = await inner.evaluate((el) => el.clientHeight);
  const innerScrollHeight = await inner.evaluate((el) => el.scrollHeight);
  const scrollerClientHeight = await scroller.evaluate((el) => el.clientHeight);
  const scrollerScrollHeight = await scroller.evaluate((el) => el.scrollHeight);

  console.log(`(B) retro류(픽스 前, 음성대조) — inner clientHeight=${innerClientHeight}, inner scrollHeight=${innerScrollHeight}, outer(#scroller) clientHeight=${scrollerClientHeight}, outer scrollHeight=${scrollerScrollHeight}`);
  const innerBroken = innerClientHeight >= innerScrollHeight; // 안 잘리고 다 보여버림(내부 스크롤 실종)
  const outerGrown = scrollerScrollHeight > scrollerClientHeight + 2; // 바깥이 전부 흡수
  const pass = innerBroken && outerGrown; // "고장난 상태 재현"이 이 케이스의 PASS 조건
  console.log(`    내부 스크롤 실종(예상대로 고장)? ${innerBroken} · 바깥이 흡수함? ${outerGrown} : ${pass ? 'PASS(실사고 정확 재현 — #4130 카드가 고치는 그 증상)' : 'FAIL(재현 실패 — 판정 로직 재검토 필요)'}`);
  if (!pass) allPass = false;
  await page.close();
}

// (C) retro류(#4130/#4131 픽스 後) — h-[calc(100svh-var(--shell-chrome-h))]로 직접 앵커(flex-1 없이! flex-1의
//     flex-basis:0%가 explicit height를 덮어써 무력화시키는 함정을 실측으로 잡아 수정 — 아래
//     참고). 내부 스크롤러가 bounded 유지되고 바깥은 안 자라야 한다.
const RETRO_FIXED = `
  <div class="px-6 pt-3" style="flex-shrink:0">고정 툴바(WorkspaceFrameTabs류)</div>
  <div data-testid="inner-scroller" class="focus-inset flex h-[calc(100svh-var(--shell-chrome-h))] min-h-0 flex-col gap-0 overflow-y-auto">
    ${manyItems(60, '#dde')}
  </div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(RETRO_FIXED, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const inner = page.getByTestId('inner-scroller');
  const scroller = page.locator('#scroller');
  const innerClientHeight = await inner.evaluate((el) => el.clientHeight);
  const innerScrollHeight = await inner.evaluate((el) => el.scrollHeight);
  const scrollerClientHeight = await scroller.evaluate((el) => el.clientHeight);
  const scrollerScrollHeight = await scroller.evaluate((el) => el.scrollHeight);

  console.log(`(C) retro류(픽스 後, h-[calc(100svh-var(--shell-chrome-h))]) — inner clientHeight=${innerClientHeight}, inner scrollHeight=${innerScrollHeight}, outer clientHeight=${scrollerClientHeight}, outer scrollHeight=${scrollerScrollHeight}`);
  const innerStillBounded = innerClientHeight < innerScrollHeight;
  // h-[calc(100svh-var(--shell-chrome-h))]는 TopBar/모바일탭바는 정확히 반영하지만(F/G 참고) "고정 툴바"(WorkspaceFrameTabs류) 자신의
  // 높이는 안 뺀다(실제 파일들에서도 명시적으로 이렇게 주석 남김·PO 라이브 확認 요청 대상) —
  // 그 툴바 높이만큼(수십 px) #scroller가 살짝 더 스크롤될 여지를 허용하되, (B)처럼 «내부
  // 리스트 전체가 그대로 다 보여버리는» 수준의 붕괴(수천 px)와는 명확히 구분한다.
  const outerSlack = scrollerScrollHeight - scrollerClientHeight;
  const outerAcceptable = outerSlack <= 100; // 툴바류 높이 슬랙(실측 36px) 허용, catastrophic 성장(B의 3400+px)과 구분
  const pass = innerStillBounded && outerAcceptable;
  console.log(`    내부 여전히 bounded? ${innerStillBounded} · 바깥 슬랙=${outerSlack}px(툴바 자체 높이만큼, 허용 ≤100px) : ${pass ? 'PASS(로컬 픽스로 내부 스크롤러 복원됨, 툴바 높이만큼의 알려진 미세 슬랙만 남음)' : 'FAIL'}`);
  if (!pass) allPass = false;
  await page.close();
}

// (D) retro류 대안 픽스 — 로컬 min-h-0/flex-1 스크롤 경계 대신, 툴바를 sticky top-0로
//     고정하고 리스트는 그냥 자연 흐름(overflow-y-auto·min-h-0 제거)으로 둔다. #4125가 이미
//     증명한 "레이어 안 sticky가 :scroller를 포함 블록으로 잡는다" 메커니즘을 재사용 —
//     more/page.tsx·rewards/page.tsx·retro/[id]/page.tsx·loops-client.tsx·channel/page.tsx
//     등 고정 툴바 有/無 케이스에 실제로 적용한 방식.
const RETRO_STICKY_TOOLBAR = `
  <div data-testid="toolbar" class="sticky top-0 z-10 bg-background px-6 pt-3" style="border-bottom:1px solid #ccc">고정 툴바(sticky)</div>
  <div data-testid="list">${manyItems(60, '#dde')}</div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(RETRO_STICKY_TOOLBAR, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const toolbar = page.getByTestId('toolbar');
  const scroller = page.locator('#scroller');
  const topBefore = await toolbar.evaluate((el) => el.getBoundingClientRect().top);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(100);
  const topAfter = await toolbar.evaluate((el) => el.getBoundingClientRect().top);
  const position = await toolbar.evaluate((el) => getComputedStyle(el).position);
  const scrollerScrollTop = await scroller.evaluate((el) => el.scrollTop);

  console.log(`(D) retro류+sticky 툴바 — position=${position}, top ${topBefore.toFixed(1)}→${topAfter.toFixed(1)}, #scroller.scrollTop=${scrollerScrollTop}`);
  const pass = position === 'sticky' && topAfter <= 5 && scrollerScrollTop > 0;
  console.log(`    ${pass ? 'PASS(툴바가 스크롤 뒤에도 top 0 고정, #scroller가 실제로 스크롤됨)' : 'FAIL'}`);
  if (!pass) allPass = false;
  await page.close();
}

// (E) docs-client-layout류(#4130/#4131 픽스 後) — 바깥 split 래퍼에 h-[calc(100svh-var(--shell-chrome-h))] 앵커.
//     aside(자기 overflow-y-auto)와 section 안 doc-content(h-full overflow-y-auto, 로컬
//     무변경 — 조상이 다시 bounded되면 h-full 체인이 저절로 복원되는지 검증)가 각각
//     bounded 유지돼야 한다.
const DOCS_LIKE = `
  <div class="flex h-[calc(100svh-var(--shell-chrome-h))] min-h-0 overflow-hidden">
    <aside data-testid="aside" class="relative hidden w-[236px] flex-shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r lg:flex" style="display:flex">
      ${manyItems(60, '#eef')}
    </aside>
    <section data-testid="section" class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div data-testid="doc-content" class="h-full overflow-y-auto px-6 py-8" style="background:#fee">
        ${manyItems(60, '#fee')}
      </div>
    </section>
  </div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(DOCS_LIKE, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const aside = page.getByTestId('aside');
  const docContent = page.getByTestId('doc-content');
  const scroller = page.locator('#scroller');

  const asideClientH = await aside.evaluate((el) => el.clientHeight);
  const asideScrollH = await aside.evaluate((el) => el.scrollHeight);
  const docContentClientH = await docContent.evaluate((el) => el.clientHeight);
  const docContentScrollH = await docContent.evaluate((el) => el.scrollHeight);
  const scrollerScrollH = await scroller.evaluate((el) => el.scrollHeight);
  const scrollerClientH = await scroller.evaluate((el) => el.clientHeight);

  console.log(`(E) docs류(픽스 後) — aside clientH=${asideClientH}/scrollH=${asideScrollH} · doc-content(h-full, 로컬 무변경) clientH=${docContentClientH}/scrollH=${docContentScrollH} · #scroller clientH=${scrollerClientH}/scrollH=${scrollerScrollH}`);
  const asideBounded = asideClientH < asideScrollH;
  const docContentBounded = docContentClientH < docContentScrollH;
  const outerNotGrown = scrollerScrollH <= scrollerClientH + 2;
  const pass = asideBounded && docContentBounded && outerNotGrown;
  console.log(`    aside bounded? ${asideBounded} · doc-content(h-full 체인) bounded? ${docContentBounded} · 바깥 안 자람? ${outerNotGrown} : ${pass ? 'PASS(조상 앵커만으로 h-full 체인 자동 복원 — doc-content 자체는 무변경으로 충분)' : 'FAIL(doc-content도 직접 손대야 함)'}`);
  if (!pass) allPass = false;
  await page.close();
}

// (F) story #4131 AC4 — var(--shell-chrome-h) 앵커가 TopBar 숨김 라우트(/settings류,
// showTopBar=false)에서 하드코딩 3rem과 달리 0을 정확히 반영하는지. 앵커 clientHeight가
// 뷰포트(560) − 0 = 560(±1px)이어야 한다 — 하드코딩 3rem이었다면 512로 48px 못 미쳤을 것.
const ANCHOR_FIXTURE = `<div data-testid="anchor" class="h-[calc(100svh-var(--shell-chrome-h))] min-h-0 overflow-hidden" style="background:#eee">${manyItems(20, '#eee')}</div>`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(ANCHOR_FIXTURE, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME, topbarHidden: true }));
  const anchor = page.getByTestId('anchor');
  const anchorClientH = await anchor.evaluate((el) => el.clientHeight);
  await page.close();

  console.log(`(F) TopBar 숨김(showTopBar=false) — 앵커 clientHeight=${anchorClientH}(기대: 뷰포트 560 그대로, --shell-chrome-h=0)`);
  const pass = Math.abs(anchorClientH - 560) <= 1;
  console.log(`    ${pass ? 'PASS(TopBar 몫 0 정확 반영 — #4130 하드코딩 3rem이었다면 512로 48px 못 미쳤을 자리)' : 'FAIL'}`);
  if (!pass) allPass = false;
}

// (G) story #4131 AC4 — <lg(1024px 미만)에서 하단 고정 탭바(--mobile-tab-bar-h=4rem=64px)
// 몫까지 앵커가 정확히 반영하는지. TopBar 표시 상태(showTopBar=true)에서 앵커
// clientHeight = 뷰포트(560) − 3rem(48) − 4rem(64) = 448(±1px).
{
  const page = await browser.newPage({ viewport: { width: 800, height: 560 } });
  await page.setContent(shellHtml(ANCHOR_FIXTURE, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME, topbarHidden: false }));
  const anchor = page.getByTestId('anchor');
  const anchorClientH = await anchor.evaluate((el) => el.clientHeight);
  await page.close();

  console.log(`(G) 모바일(<1024px)+TopBar 표시 — 앵커 clientHeight=${anchorClientH}(기대: 560−48−64=448)`);
  const pass = Math.abs(anchorClientH - 448) <= 1;
  console.log(`    ${pass ? 'PASS(TopBar+모바일 탭바 몫 둘 다 정확 반영 — #4130 하드코딩 3rem이었다면 512로 탭바 64px만큼 뷰포트를 넘쳤을 자리)' : 'FAIL'}`);
  if (!pass) allPass = false;
}

// (H) story #4131 AC3 — sprints-client.tsx류(자기 페이지 툴바 WorkspaceFrameTabs가 앵커
// 밖에 별도로 있던 유일한 실 파일)를 sticky 흐름으로 앵커 「안」에 끌어들인 실제 수정과
// 동형 구조 — 외곽 #scroller가 툴바 높이만큼도 안 자라야 한다(슬랙 0 수치 확認).
const SPRINTS_TOOLBAR_INSIDE = `
  <div data-testid="sprints-anchor" class="focus-inset flex h-[calc(100svh-var(--shell-chrome-h))] min-h-0 flex-col overflow-y-auto">
    <div data-testid="sprints-toolbar" class="sticky top-0 z-10 shrink-0 bg-background px-6 pt-3" style="border-bottom:1px solid #ccc">WorkspaceFrameTabs</div>
    <div>${manyItems(60, '#dde')}</div>
  </div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(SPRINTS_TOOLBAR_INSIDE, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const scroller = page.locator('#scroller');
  const toolbar = page.getByTestId('sprints-toolbar');
  const scrollerScrollH = await scroller.evaluate((el) => el.scrollHeight);
  const scrollerClientH = await scroller.evaluate((el) => el.clientHeight);
  const topBefore = await toolbar.evaluate((el) => el.getBoundingClientRect().top);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(100);
  const topAfter = await toolbar.evaluate((el) => el.getBoundingClientRect().top);
  const scrollerScrollTop = await scroller.evaluate((el) => el.scrollTop);
  await page.close();

  const outerSlack = scrollerScrollH - scrollerClientH;
  console.log(`(H) sprints-client.tsx류(툴바를 앵커 안 sticky로) — 바깥 슬랙=${outerSlack}px(기대 0) · 툴바 top ${topBefore.toFixed(1)}→${topAfter.toFixed(1)}(스크롤 300px 뒤) · #scroller.scrollTop=${scrollerScrollTop}(기대 0, 앵커 자체가 스크롤 흡수)`);
  const pass = outerSlack === 0 && Math.abs(topAfter - topBefore) < 1 && scrollerScrollTop === 0;
  console.log(`    ${pass ? 'PASS(WorkspaceFrameTabs 자체 높이 슬랙 0 — #4130의 36px 슬랙 해소 확認)' : 'FAIL — 슬랙 재발'}`);
  if (!pass) allPass = false;
}

// (I) P0 핫픽스(선생님 실사용 2026-09-22 03:24Z, 페드루 PO 라이브 사슬 실측) —
// chats/layout.tsx 루트가 #4130 착지 前엔 `flex-1`(부모 캡 의존)만 썼는데, #4130이
// 부모(dashboard-shell 콘텐츠 열)의 min-h-0를 뺀 뒤로 그 캡을 잃어 chat-view.tsx의
// 내부 스크롤러(`relative min-h-0 flex-1 overflow-y-auto`, 실 소스 그대로)가 내용
// 높이로 자라 무한 backfill(맨 위 sentinel이 스크롤러 뷰포트 안에 항상 들어옴)로
// 이어졌다. docs류(E)와 동형 처방(조상에 h-[calc(100svh-var(--shell-chrome-h))]
// 앵커) — chat-view 자신은 무변경으로 bounded 복원되는지 검증한다.
const CHATS_LIKE = `
  <div class="flex h-[calc(100svh-var(--shell-chrome-h))] min-h-0 overflow-hidden">
    <div data-testid="chat-rail" class="hidden lg:flex min-h-0 w-[270px] shrink-0 flex-col overflow-hidden border-r">rail</div>
    <div data-testid="chat-outlet" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div style="flex-shrink:0;border-bottom:1px solid #ccc;padding:8px 16px">채팅 헤더(고정)</div>
      <div data-testid="chat-scroller" class="relative min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div class="flex flex-col gap-4">
          <div data-testid="sentinel" class="h-px w-full"></div>
          ${manyItems(80, '#eef')}
        </div>
      </div>
    </div>
  </div>
`;
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 560 } });
  await page.setContent(shellHtml(CHATS_LIKE, { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME }));
  const chatScroller = page.getByTestId('chat-scroller');
  const scroller = page.locator('#scroller');

  const chatClientH = await chatScroller.evaluate((el) => el.clientHeight);
  const chatScrollH = await chatScroller.evaluate((el) => el.scrollHeight);
  const scrollerClientH = await scroller.evaluate((el) => el.clientHeight);
  const scrollerScrollH = await scroller.evaluate((el) => el.scrollHeight);
  await page.close();

  console.log(`(I) chats/[id](P0 핫픽스) — chat-view 내부 스크롤러 clientH=${chatClientH}/scrollH=${chatScrollH} · 바깥 #scroller clientH=${scrollerClientH}/scrollH=${scrollerScrollH}`);
  const chatBounded = chatClientH < chatScrollH - 2; // 내부 스크롤러가 콘텐츠를 다 못 보여줘야(진짜 스크롤 가능) — 무한로드의 반대 증거
  const outerNotGrown = scrollerScrollH <= scrollerClientH + 2; // 바깥 셸 스크롤러가 안 자람(내부로 흡수 안 됨)
  const pass = chatBounded && outerNotGrown;
  console.log(`    chat-view 내부 스크롤러 bounded(무한로드 0)? ${chatBounded} · 바깥 #scroller 안 자람(라이브 증상 재현 0)? ${outerNotGrown} : ${pass ? 'PASS(조상 앵커만으로 chat-view 무변경 복원 — docs류 E와 동형)' : 'FAIL — #4130 회귀급 재발'}`);
  if (!pass) allPass = false;
}

await browser.close();
console.log(allPass ? '\nOK — 전부 기대대로' : '\nFAIL — 위 판정 참고');
process.exit(allPass ? 0 : 1);
