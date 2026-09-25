/**
 * story #4277(high · 민 기기 탐색 점검 배포 27 · iPhone 17 402×874) — 전 경로 가로 넘침 가드.
 *
 * 무엇을 막나: 402폭에서 화면이 가로로 넘쳐 사람 행동(«승인하고 서명» · «보내기»)이 화면 밖으로 밀리는 것(4277 1번 · 2번 · 5번 · 6번 · 15번).
 * 어디를 재나: 전체 메뉴(/more의 메뉴 링크 전부) + 하단 탭바 링크 전부 — **실행 때 화면에서 읽어** 모은다. 새 화면을 메뉴에 붙이면 자동으로
 *   이 가드 대상이 된다(목록을 손으로 들고 있지 않는다).
 * 어떻게 재나: e2e/helpers/horizontal-overflow.ts — documentElement뿐 아니라 셸의 세로 스크롤러(가로도 암묵 스크롤)까지. 옛 자
 *   (documentElement만)는 4277 1번을 0으로 쟀다(스크롤러 896 · documentElement 402).
 * 데이터 있는 상태: 빈 화면은 넘칠 것이 없어 거짓 PASS다. beforeAll에서 **API로만** 긴 제목 데이터를 심는다 — 프로젝트 · 소유자 이름 ·
 *   긴 스토리 · 에이전트가 긴 제목 문서를 소유자에게 결재 요청(→ «오늘»의 «서명 대기» 줄). DB 직접 쓰기 0.
 *
 * CI: ci.yml contrast-guard-e2e 잡(플래그 OFF 기본 탭바 · owner@sprintable.dev · 빈 조직 e2e-ci)에서 돈다.
 */
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { findHorizontalOverflow } from './helpers/horizontal-overflow';

// 민 기기와 같은 조건: 402×874 · 한국어(글자 버튼 폭이 로케일마다 달라 en만 재면 «새 실행 시작하기» 같은 긴 한국어 라벨을 놓친다).
test.use({ storageState: 'playwright/.auth/owner.json', viewport: { width: 402, height: 874 }, locale: 'ko-KR' });
// 두 테스트가 같은 dev 서버 · 같은 시드 데이터를 쓴다 — 병렬로 돌면 서로의 이동이 섞인다(CI는 workers=1이지만 로컬 기본은 병렬).
test.describe.configure({ mode: 'serial' });

const FASTAPI = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
const OWNER = { email: 'owner@sprintable.dev', password: 'password123' };
const LONG_STORY_TITLES = [
  '[CI·prod 승격 준비] v3 원시 토큰 diff 범위 가드(3826 AC1)가 토큰 교체 PR을 «토큰 교체 PR»로 오판해 FAIL — 이 가드 범위를 좁혀야 한다',
  '[prod 승격 차단·BE/infra] main push 배포의 migrate 잡이 prod DB에 develop 파일셋으로 upgrade heads를 돌려 스키마가 앞서간다',
  'AReallyLongUnbrokenTokenWithoutAnySpacesThatCannotWrapAnywhereInTheLayoutAtAll_0123456789_abcdefghijklmnopqrstuvwxyz',
];
// 보드 칸이 실제로 넘치게(안쪽 세로 스크롤이 «있다»가 아니라 «움직인다»를 재려고 · 까디르 검수 P2) 짧은 스토리 여럿.
const FILLER_STORY_COUNT = 16;
const PROJECT_NAME = '넘침 가드 프로젝트 · 이름이 긴 편';
// beforeAll이 만든(또는 찾은) 프로젝트 — 모든 이동에 `?p=`로 싣는다(4231 규칙). 안 실으면 소유자의 다른 프로젝트 · 선택기로 떨어져
// 시드한 긴 데이터를 안 보고도 초록이 될 수 있었다(까디르 검수 P1).
let seededProjectId = '';
// 이미 `p=`가 있으면 그대로(메뉴 링크 대부분은 `/more`가 싣는다) · 없으면 붙인다 — `/more`의 자원 항목(`/docs` · `/loops` · `/storage`)은
// `p` 없이 나와 프록시가 쿠키 프로젝트로 고르므로 순회가 다른 프로젝트를 잴 수 있었다(까디르 검수 · 그 링크 자체의 결함은 별 카드).
const withProject = (path: string) => (/[?&]p=/.test(path) ? path : `${path}${path.includes('?') ? '&' : '?'}p=${seededProjectId}`);
const LONG_DOC_TITLE = '[FE·prod 승격 준비] 명령 팔레트 «작업 목록»이 /work-list(직접 경로)로 보내는데 옛 주소 변환 표에 work-list가 없어 404가 난다';

/** 응답 봉투({data} · 날것 · 목록)에서 조건에 맞는 첫 객체를 찾는다. */
function findDeep(value: unknown, pred: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findDeep(v, pred); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (pred(o)) return o;
    for (const v of Object.values(o)) { const hit = findDeep(v, pred); if (hit) return hit; }
  }
  return null;
}

async function json(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<unknown> {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext({ baseURL: FASTAPI });
  const token = (findDeep(await json(await api.post('/api/v2/auth/token', { data: OWNER }), 'owner token'), (o) => typeof o['access_token'] === 'string')!['access_token']) as string;
  const orgs = await json(await api.get('/api/v2/organizations', { headers: { authorization: `Bearer ${token}` } }), 'orgs');
  const org = findDeep(orgs, (o) => typeof o['id'] === 'string' && typeof o['slug'] === 'string');
  if (!org) throw new Error('e2e 소유자 조직이 없다(CI의 Onboard e2e owner 스텝 확認)');
  const orgId = org['id'] as string;
  const H = { authorization: `Bearer ${token}`, 'X-Org-Id': orgId };

  // 소유자 이름 — 이름 없는 멤버가 있으면 보드 담당자 필터가 크래시한다(별 카드). 실사용자는 가입 때 이름이 있다.
  const me = findDeep(await json(await api.patch('/api/v2/me', { headers: H, data: { name: '넘침 가드 소유자' } }), 'me'), (o) => typeof o['id'] === 'string')!;
  const ownerMemberId = me['id'] as string;

  const projects = await json(await api.get('/api/v2/projects', { headers: H }), 'projects');
  let project = findDeep(projects, (o) => o['slug'] === 'overflow-guard');
  if (!project) {
    project = findDeep(await json(await api.post('/api/v2/projects', { headers: H, data: { org_id: orgId, name: 'Overflow Guard', slug: 'overflow-guard' } }), 'project'), (o) => typeof o['id'] === 'string');
  }
  const projectId = project!['id'] as string;
  seededProjectId = projectId;
  // 실사용 프로젝트 이름 길이(민 기기의 «뭉클랩 / 제로고»처럼 상단바 컨텍스트 칩이 최대 폭까지 차는 쪽) — 짧은 이름이면 칩이 좁아 상단바 경합이 안 드러난다.
  await json(await api.patch(`/api/v2/projects/${projectId}`, { headers: H, data: { name: PROJECT_NAME } }), 'project name');

  for (const title of LONG_STORY_TITLES) {
    await json(await api.post('/api/v2/stories', { headers: H, data: { org_id: orgId, project_id: projectId, title } }), 'story');
  }
  for (let i = 1; i <= FILLER_STORY_COUNT; i++) {
    await json(await api.post('/api/v2/stories', { headers: H, data: { org_id: orgId, project_id: projectId, title: `넘침 가드 채움 스토리 ${i}` } }), 'filler story');
  }

  // 에이전트가 소유자에게 긴 제목 문서 결재를 요청 → 소유자 «오늘»에 «서명 대기» 줄(doc_approval · 고위험). 본인 결재 지정은 서버가 막는다.
  const agent = findDeep(await json(await api.post('/api/v2/team-members', { headers: H, data: { org_id: orgId, project_id: projectId, type: 'agent', name: '넘침 가드 에이전트' } }), 'agent'), (o) => typeof o['id'] === 'string')!;
  // 방금 만든 에이전트가 키 발급 조회에 보이기까지 짧은 지연이 있다(로컬 실측: 즉시 호출 404 «Agent not found» · 잠시 뒤 201) — 짧게 다시 시도(상한 10회).
  let keyRes = await api.post(`/api/v2/agents/${agent['id'] as string}/api-keys`, { headers: H, data: { expires_at: '2099-01-01T00:00:00Z' } });
  for (let i = 0; i < 10 && keyRes.status() === 404; i++) {
    await new Promise((r) => setTimeout(r, 500));
    keyRes = await api.post(`/api/v2/agents/${agent['id'] as string}/api-keys`, { headers: H, data: { expires_at: '2099-01-01T00:00:00Z' } });
  }
  const key = findDeep(await json(keyRes, 'agent key'), (o) => typeof o['api_key'] === 'string')!['api_key'] as string;
  const AH = { authorization: `Bearer ${key}` };
  const doc = findDeep(await json(await api.post('/api/v2/docs', { headers: AH, data: { org_id: orgId, project_id: projectId, slug: `overflow-guard-${Date.now()}`, title: LONG_DOC_TITLE, content: '본문' } }), 'doc'), (o) => typeof o['id'] === 'string')!;
  await json(await api.post(`/api/v2/docs/${doc['id'] as string}/transition`, { headers: AH, data: { status: 'pending', approver_member_id: ownerMemberId } }), 'doc approval');
  await api.dispose();
});

test('⭐402폭 — 전체 메뉴 · 탭바 모든 목적지에서 가로 넘침 0(데이터 있는 상태 · 셸 스크롤러까지)', async ({ page }) => {
  test.setTimeout(15 * 60_000);

  await page.goto(withProject('/more'), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="more-menu-link"]').first().waitFor({ timeout: 60_000 });
  // 양성 대조(까디르 검수 P1) — 시드한 프로젝트에 실제로 들어왔다: 상단바 컨텍스트 칩에 긴 프로젝트 이름이 실린다.
  await expect(page.locator('[data-testid="top-bar"]')).toContainText(PROJECT_NAME.slice(0, 8), { timeout: 30_000 });
  const menu = await page.locator('[data-testid="more-menu-link"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const tabs = await page.locator('[data-testid="mobile-tab-bar"] a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const destinations = [...new Set([...tabs, ...menu].filter((h) => h.startsWith('/')))];
  // 가드가 비어 있으면 아무것도 안 잰 채 초록이 된다(빈 목록 = 거짓 PASS) — 하한을 둔다(탭 4 + 메뉴 여럿).
  expect(destinations.length, `모은 목적지: ${JSON.stringify(destinations)}`).toBeGreaterThanOrEqual(10);

  for (const href of destinations) {
    await page.goto(withProject(href), { waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor({ state: 'visible' });
    // 데이터가 그려질 시간(SSE · 폴링으로 networkidle이 안 오는 화면이 있어 고정 대기).
    await page.waitForTimeout(2500);
    // bare 경로(/flow 등)는 셸이 {ws}/{proj}로 한 번 더 옮긴다 — 재는 도중 이동하면 evaluate 문맥이 사라진다. 이동이 끝나면 다시 잰다(상한 3).
    let offenders: Awaited<ReturnType<typeof findHorizontalOverflow>> = [];
    for (let attempt = 0; ; attempt++) {
      try {
        offenders = await findHorizontalOverflow(page);
        break;
      } catch (e) {
        if (attempt >= 2 || !String(e).includes('Execution context was destroyed')) throw e;
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
      }
    }
    expect.soft(offenders, `${href} @402 — 가로 넘침(스크롤러 scrollWidth > clientWidth): ${JSON.stringify(offenders)}`).toEqual([]);
  }
});

// 가로 넘침 자로는 안 잡히는 402폭 자리(찌그러짐 · 여백) — 4277 2번 · 5번 · 6번 · 20번. 실 브라우저에서 모양을 잰다.
test('402폭 — 스토리지 한 단 · 상단바 벨 화면 안 · 일감 바닥 여백', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  // 셸 상단바(TopBar)의 모든 자식이 화면 안(오른쪽 끝 ≤ 뷰포트) — 글자 버튼이 벨을 밀어내던 5번 · 6번.
  const topBarInsideViewport = (checkTitle: boolean) => page.evaluate((checkTitleArg) => {
    const bar = document.querySelector('[data-testid="top-bar"]');
    if (!bar) return 'no top bar';
    const W = window.innerWidth + 1;
    const out = [...bar.querySelectorAll('button, a')].filter((e) => e.getBoundingClientRect().right > W).map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').slice(0, 30));
    // 6번 — 글자 버튼이 제목 칸을 먹어 짧은 제목(«실행»)이 «실.»로 잘리던 것: 제목(h1 · p)이 말줄임 없이 다 보여야 한다.
    // 칩이 먼저 양보하므로(shrink-[10000] · 최소 44px) 짧은 제목은 문서 · 실행 · 결재 모두 온전해야 한다.
    // 말줄임 요소를 빼지 않는다(까디르 검수 P3 판단): 6번 결함 자체가 말줄임(«실…»)이었다. 이 검사는 세 화면의 고정된 짧은 화면 이름
    // («문서» · «실행» · «알림 N»)에만 걸린다 — 사람이 쓴 긴 제목(말줄임이 기대 동작)은 이 검사의 대상이 아니다.
    const title = bar.querySelector('h1, p');
    if (checkTitleArg && title && title.scrollWidth > title.clientWidth + 1) out.push(`제목 잘림: ${title.textContent ?? ''}`);
    return out.length ? out : 'ok';
  }, checkTitle);

  await page.goto(withProject('/more'), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="more-menu-link"]').first().waitFor({ timeout: 60_000 });
  const hrefs = await page.locator('[data-testid="more-menu-link"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const pick = (part: string) => hrefs.find((h) => h.split('?')[0]!.endsWith(part));

  // 결재(/inbox) — 유나 4636 측정 때 본 «알림 120» 제목이 오른쪽 칩 · 버튼에 눌려 잘리던 자리(같은 상단바 부류 · PO 20:26Z).
  for (const part of ['/docs', '/loops', '/inbox']) {
    const href = part === '/inbox' ? withProject('/inbox?tab=notifications') : pick(part);
    expect(href, `${part} 메뉴 링크`).toBeTruthy();
    await page.goto(withProject(href!), { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="top-bar"]').waitFor({ timeout: 60_000 });
    // 로딩 중 상단바엔 화면 액션이 아직 없다(실행 화면은 로딩 때 액션 없는 TopBarSlot) — 액션 버튼이 붙은 뒤에 잰다.
    await page.locator('[data-testid="top-bar"] [aria-label]').nth(4).waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    expect.soft(await topBarInsideViewport(true), `${part} 상단바 — 화면 밖으로 밀린 버튼 · 제목 잘림`).toBe('ok');
  }

  // 2번 — 스토리지: 폰은 한 단(폴더 트리는 서랍) · 목록이 화면 폭을 거의 다 쓴다(예전: 폴더 칸 248px 고정 → 목록 약 150px).
  const storage = pick('/storage');
  expect(storage, '스토리지 메뉴 링크').toBeTruthy();
  await page.goto(withProject(storage!), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="storage-asset-list"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await expect.soft(page.locator('[data-testid="storage-folder-drawer-trigger"]')).toBeVisible();
  const listWidth = await page.locator('[data-testid="storage-asset-list"]').evaluate((e) => e.getBoundingClientRect().width);
  expect.soft(listWidth, '스토리지 목록 폭(402폭)').toBeGreaterThan(300);
  // story #4277(PO 라이브 반려) — 목록 폭만 보면 이름 칸이 0px여도 초록이었다(행 고정 칸 합 462 > 402). 행이 있으면 첫 행의 이름 블록 실제 폭을 잰다.
  // 시드: 로컬 저장소 공급자는 업로드(PUT)를 아직 못 받아(story dc3d62f4) 이 스펙이 자산을 만들 수 없다 — 칸 예산은 단위 테스트
  // (storage-asset-row.grid-budget.test.tsx)가 결정적으로 잡고, 여기선 자산이 있는 환경에서만 실측한다.
  // CI 36138526074 — 예전엔 `.first().evaluate()`가 행 **출현을 기다려** 자산 0이면 테스트 제한시간까지 걸린 뒤(~6분) 실패 · 재시도했다.
  // 행을 기다리지 않는다: 목록 몸통이 «불러오는 중»을 벗어나길 짧게 기다려 상태를 **한 번** 읽고, 행이 있을 때만 잰다.
  const listBody = page.locator('[data-testid="storage-asset-list-body"]:not([data-state="loading"])');
  await listBody.waitFor({ timeout: 30_000 });
  const listState = await listBody.getAttribute('data-state');
  expect.soft(listState, '스토리지 목록 불러오기 실패').not.toBe('error');
  const firstNameWidth = listState === 'rows'
    ? await page.locator('[data-testid="storage-asset-list"] [role="button"][aria-pressed] > div.min-w-0').first()
      .evaluate((e) => e.getBoundingClientRect().width, undefined, { timeout: 10_000 }).catch(() => null)
    : null;
  if (firstNameWidth !== null) {
    expect.soft(firstNameWidth, '스토리지 첫 행 이름 칸 폭(402폭)').toBeGreaterThanOrEqual(200);
  } else {
    // 재지 않고 초록으로 넘어가지 않게(PO 4277 — «목록 폭 > 300»처럼 헛도는 가드 금지): 건너뜀을 결과 · 로그에 남긴다. 가드는 칸 예산 단위 테스트.
    test.info().annotations.push({ type: 'skipped-check', description: `스토리지 이름 칸 폭: 자산 행 0(목록 상태 ${listState} · 로컬 업로드 불가 · story dc3d62f4) — 칸 예산 단위 테스트가 가드` });
    console.log(`[mobile-width-overflow] SKIPPED storage name-width check: no asset rows (list state ${listState} · seed upload unsupported · story dc3d62f4)`);
  }
  // 4277(PO 402 라이브) — 상단 «N개 자산 · 용량» 알약이 상단바 밖으로 말줄임 없이 잘리던 것: 화면 이름(h1)은 온전 · 알약은 화면 안에서
  // 끝나거나(다 보임) 말줄임으로 줄어든다(잘린 채 숨지 않음).
  expect.soft(await topBarInsideViewport(true), '/storage 상단바 — 화면 밖으로 밀린 버튼 · 제목 잘림').toBe('ok');
  const pill = await page.locator('[data-testid="storage-summary-badge"]').evaluate((b) => {
    const inner = b.querySelector('span') as HTMLElement;
    return {
      inside: b.getBoundingClientRect().right <= window.innerWidth + 1,
      fits: inner.scrollWidth <= inner.clientWidth + 1,
      ellipsis: getComputedStyle(inner).textOverflow === 'ellipsis',
    };
  });
  expect.soft(pill.inside, '스토리지 요약 알약이 화면 안에서 끝난다').toBe(true);
  expect.soft(pill.fits || pill.ellipsis, '스토리지 요약 알약 — 다 보이거나 말줄임').toBe(true);

  // 20번 — 일감 맨 아래 «승인 흐름에서 멈춘 것» 상자와 탭바 사이 여백(예전 0). 판정(PO 4639 · 까디르 검수 P2):
  // - 명시 높이 틀(flow-board-frame) 안에서 보드가 넘치지 않는다(틀 scrollHeight − clientHeight ≤ 1 — 자동 높이 부모 기준이면 0이 당연해 뜻이 없다).
  // - 맨 아래 상자와 탭바 사이 틈 16(뿌리 p-4).
  // - 보드 칸이 긴 내용(시드 스토리 19)으로 실제로 넘치고 **스크롤이 움직인다**(scrollTop 이동).
  await page.goto(withProject('/flow'), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="flow-board-frame"]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('details').last().waitFor({ state: 'attached', timeout: 90_000 });
  // 양성 대조 — 이 실행이 시드한 스토리가 이 보드에 실제로 그려졌다(다른 프로젝트 · 빈 보드면 여기서 RED). 칸은 최신 20장만 그려
  // 먼저 만든 긴 제목 스토리는 채움 스토리에 밀려 첫 장에 없다(로컬 실측) — 마지막에 만든 채움 스토리로 확인한다. 부하 걸린 dev 서버에서
  // 보드가 채워지기까지 15~30초(실측)라 넉넉히.
  await expect(page.locator('[data-testid="flow-board-frame"]').getByText(`넘침 가드 채움 스토리 ${FILLER_STORY_COUNT}`, { exact: true }).first()).toBeAttached({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  const flow = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="flow-board-frame"]')!;
    const det = [...document.querySelectorAll('details')].pop()!;
    let sc: HTMLElement | null = det.parentElement;
    while (sc && !/overflow-y-auto/.test(sc.className)) sc = sc.parentElement;
    if (!sc) return null;
    sc.scrollTop = sc.scrollHeight;
    // 틀 안 세로 스크롤러 중 내용이 가장 긴 것(보드 칸).
    const scrollers = [...frame.querySelectorAll<HTMLElement>('*')].filter((e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.getClientRects().length > 0);
    const inner = scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] ?? null;
    let moved = 0;
    if (inner) { inner.scrollTop = 120; moved = inner.scrollTop; inner.scrollTop = 0; }
    return {
      frameOverflow: frame.scrollHeight - frame.clientHeight,
      gap: sc.getBoundingClientRect().bottom - det.getBoundingClientRect().bottom,
      innerOverflows: inner ? inner.scrollHeight > inner.clientHeight : false,
      innerMoved: moved,
    };
  });
  expect(flow, '일감 화면 셸 스크롤러').not.toBeNull();
  expect.soft(flow!.frameOverflow, '보드 틀 넘침(scrollHeight − clientHeight · 명시 높이 부모)').toBeLessThanOrEqual(1);
  expect.soft(flow!.gap, '일감 바닥 상자 ↔ 탭바 여백(px)').toBeGreaterThanOrEqual(15.5);
  expect.soft(flow!.innerOverflows, '보드 칸이 긴 내용으로 넘침(시드 스토리 19)').toBe(true);
  expect.soft(flow!.innerMoved, '보드 칸 안 세로 스크롤이 실제로 움직임(scrollTop)').toBeGreaterThan(0);
});

