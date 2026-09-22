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

function shellHtml(innerContent, { className, contentClassName }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${findCompiledCss()}</style></head>
<body>
  <div class="h-svh dashboard-shell-root flex w-full">
    <main class="relative flex w-full flex-1 flex-col overflow-hidden">
      <div id="scroller" class="flex flex-1 min-h-0 flex-col overflow-y-auto">
        <div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">TopBar(48px)</div>
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
function gatesLikeHtml() {
  return `
  <div data-testid="gate-detail-container" class="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-5 lg:max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
    <div>${manyItems(40, '#eee')}</div>
    <div data-testid="action-column" class="proof-surface mt-3 space-y-3 border p-4 lg:mt-0 lg:sticky lg:top-12 lg:self-start" style="background:#fff">우 열(sticky)</div>
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
  const position = await action.evaluate((el) => getComputedStyle(el).position);
  const topBefore = await action.evaluate((el) => el.getBoundingClientRect().top);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(100);
  const topAfter = await action.evaluate((el) => el.getBoundingClientRect().top);
  const scrollerScrollTop = await scroller.evaluate((el) => el.scrollTop);
  await page.close();

  return { label, containerClientH, containerScrollH, position, topBefore, topAfter, scrollerScrollTop };
}

{
  const after = await runGatesScenario('AFTER(실 소스 현재값)', { className: CURRENT_CLASSNAME, contentClassName: CURRENT_CONTENT_CLASSNAME });
  const before = await runGatesScenario('BEFORE(#4130 착지 前 고정값)', { className: BEFORE_CLASSNAME, contentClassName: BEFORE_CONTENT_CLASSNAME });

  for (const r of [before, after]) {
    console.log(`(A-${r.label}) container clientH=${r.containerClientH}/scrollH=${r.containerScrollH} · position=${r.position} · top ${r.topBefore.toFixed(1)}→${r.topAfter.toFixed(1)}(스크롤 400px 뒤) · #scroller.scrollTop=${r.scrollerScrollTop}`);
  }

  // 핵심 기계적 주장(이 카드의 AC1) — AFTER: 컨테이너 박스가 내용 높이만큼 자란다
  // (clientH≈scrollH). BEFORE: 컨테이너가 스크롤러 가용폭에 캡된다(clientH<scrollH,
  // Pedro 라이브 실측 496/1422와 같은 모양). 이 못 틀리는 대조는 이제 정확히 성립한다.
  const afterGrew = after.containerClientH >= after.containerScrollH - 2;
  const beforeCapped = before.containerClientH < before.containerScrollH - 2;
  const containerClaim = afterGrew && beforeCapped;

  // ⚠️sticky 자체는 이 단순화 fixture(순수 <div> 좌 열, 실 ProofCapsule 아님)에서 BEFORE/
  // AFTER 둘 다 "정상 추종"으로 관측됐다(both position=sticky, top 정착 48, scroller가
  // 스크롤됨) — gate-detail-container가 overflow:visible이라(overflow-hidden/auto 없음)
  // 컨테이너 자체 박스가 캡돼 있어도 sticky의 스크롤 컨텍스트 탐색이 그 캡을 무시하고
  // #scroller까지 올라가 버리기 때문으로 보인다(CSS sticky 컨테이닝 블록 규칙 — overflow:
  // visible 조상은 클리핑/스크롤 컨텍스트로 안 잡힘). 즉 라이브에서 Pedro가 관측한 "sticky가
  // 실제로 안 움직인다"는 증상을 이 순수-<div> 모델만으로는 재현 못 했다 — 실 ProofCapsule
  // 내부 구조나 실 콘텐츠 특성에 이 fixture가 놓친 요인이 있을 수 있다(Kadir/PO 라이브
  // devtools 재검이 이 gap을 메워야 함, 아래 로그에 두 상태 나란히 남겨 참고용으로 제공).
  const stickyBothWork = after.position === 'sticky' && after.topAfter < 60 && after.topAfter >= 40
    && before.position === 'sticky' && before.topAfter < 60 && before.topAfter >= 40;

  const pass = containerClaim; // AC1의 기계적 주장만으로 판정 — sticky 자체는 참고 로그
  console.log(`(A) 판정 — 컨테이너 성장 주장(AC1 핵심, 못 틀리는 대조) AFTER 자람? ${afterGrew} · BEFORE 캡? ${beforeCapped} : ${containerClaim ? 'PASS' : 'FAIL — CHANGES-1 재발'}`);
  console.log(`    참고(gap) — 이 단순화 fixture에선 sticky 자체가 BEFORE/AFTER 둘 다 "정상 추종"으로 관측됨(${stickyBothWork}) — overflow:visible 조상은 sticky 스크롤 컨텍스트 탐색을 안 막기 때문으로 보임. 라이브에서 관측된 "sticky가 실제로 안 움직인다" 증상은 이 순수-<div> 모델로는 재현 못 함 — 실 ProofCapsule 구조 차이일 가능성, Kadir/PO 라이브 devtools 재검 요청.`);
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

// (C) retro류(#4130 픽스 後) — h-[calc(100svh-3rem)]로 직접 앵커(flex-1 없이! flex-1의
//     flex-basis:0%가 explicit height를 덮어써 무력화시키는 함정을 실측으로 잡아 수정 — 아래
//     참고). 내부 스크롤러가 bounded 유지되고 바깥은 안 자라야 한다.
const RETRO_FIXED = `
  <div class="px-6 pt-3" style="flex-shrink:0">고정 툴바(WorkspaceFrameTabs류)</div>
  <div data-testid="inner-scroller" class="focus-inset flex h-[calc(100svh-3rem)] min-h-0 flex-col gap-0 overflow-y-auto">
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

  console.log(`(C) retro류(픽스 後, h-[calc(100svh-3rem)]) — inner clientHeight=${innerClientHeight}, inner scrollHeight=${innerScrollHeight}, outer clientHeight=${scrollerClientHeight}, outer scrollHeight=${scrollerScrollHeight}`);
  const innerStillBounded = innerClientHeight < innerScrollHeight;
  // h-[calc(100svh-3rem)]는 TopBar(48px)만 빼고 "고정 툴바"(WorkspaceFrameTabs류) 자신의
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

// (E) docs-client-layout류(#4130 픽스 後) — 바깥 split 래퍼에 h-[calc(100svh-3rem)] 앵커.
//     aside(자기 overflow-y-auto)와 section 안 doc-content(h-full overflow-y-auto, 로컬
//     무변경 — 조상이 다시 bounded되면 h-full 체인이 저절로 복원되는지 검증)가 각각
//     bounded 유지돼야 한다.
const DOCS_LIKE = `
  <div class="flex h-[calc(100svh-3rem)] min-h-0 overflow-hidden">
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

await browser.close();
console.log(allPass ? '\nOK — 전부 기대대로' : '\nFAIL — 위 판정 참고');
process.exit(allPass ? 0 : 1);
