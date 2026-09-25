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
  // 실사용 프로젝트 이름 길이(민 기기의 «뭉클랩 / 제로고»처럼 상단바 컨텍스트 칩이 최대 폭까지 차는 쪽) — 짧은 이름이면 칩이 좁아 상단바 경합이 안 드러난다.
  await json(await api.patch(`/api/v2/projects/${projectId}`, { headers: H, data: { name: '넘침 가드 프로젝트 · 이름이 긴 편' } }), 'project name');

  for (const title of LONG_STORY_TITLES) {
    await json(await api.post('/api/v2/stories', { headers: H, data: { org_id: orgId, project_id: projectId, title } }), 'story');
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

  await page.goto('/more', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="more-menu-link"]').first().waitFor({ timeout: 60_000 });
  const menu = await page.locator('[data-testid="more-menu-link"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const tabs = await page.locator('[data-testid="mobile-tab-bar"] a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const destinations = [...new Set([...tabs, ...menu].filter((h) => h.startsWith('/')))];
  // 가드가 비어 있으면 아무것도 안 잰 채 초록이 된다(빈 목록 = 거짓 PASS) — 하한을 둔다(탭 4 + 메뉴 여럿).
  expect(destinations.length, `모은 목적지: ${JSON.stringify(destinations)}`).toBeGreaterThanOrEqual(10);

  for (const href of destinations) {
    await page.goto(href, { waitUntil: 'domcontentloaded' });
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
    const title = bar.querySelector('h1, p');
    if (checkTitleArg && title && title.scrollWidth > title.clientWidth + 1) out.push(`제목 잘림: ${title.textContent ?? ''}`);
    return out.length ? out : 'ok';
  }, checkTitle);

  await page.goto('/more', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="more-menu-link"]').first().waitFor({ timeout: 60_000 });
  const hrefs = await page.locator('[data-testid="more-menu-link"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const pick = (part: string) => hrefs.find((h) => h.split('?')[0]!.endsWith(part));

  // 결재(/inbox) — 유나 4636 측정 때 본 «알림 120» 제목이 오른쪽 칩 · 버튼에 눌려 잘리던 자리(같은 상단바 부류 · PO 20:26Z).
  for (const part of ['/docs', '/loops', '/inbox']) {
    const href = part === '/inbox' ? '/inbox?tab=notifications' : pick(part);
    expect(href, `${part} 메뉴 링크`).toBeTruthy();
    await page.goto(href!, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="top-bar"]').waitFor({ timeout: 60_000 });
    // 로딩 중 상단바엔 화면 액션이 아직 없다(실행 화면은 로딩 때 액션 없는 TopBarSlot) — 액션 버튼이 붙은 뒤에 잰다.
    await page.locator('[data-testid="top-bar"] [aria-label]').nth(4).waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    expect.soft(await topBarInsideViewport(true), `${part} 상단바 — 화면 밖으로 밀린 버튼 · 제목 잘림`).toBe('ok');
  }

  // 2번 — 스토리지: 폰은 한 단(폴더 트리는 서랍) · 목록이 화면 폭을 거의 다 쓴다(예전: 폴더 칸 248px 고정 → 목록 약 150px).
  const storage = pick('/storage');
  expect(storage, '스토리지 메뉴 링크').toBeTruthy();
  await page.goto(storage!, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="storage-asset-list"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await expect.soft(page.locator('[data-testid="storage-folder-drawer-trigger"]')).toBeVisible();
  const listWidth = await page.locator('[data-testid="storage-asset-list"]').evaluate((e) => e.getBoundingClientRect().width);
  expect.soft(listWidth, '스토리지 목록 폭(402폭)').toBeGreaterThan(300);

  // 20번 — 일감 맨 아래 «승인 흐름에서 멈춘 것» 상자와 탭바 사이 여백(예전 0). 판정(PO 4639): 일감 뿌리가 넘치지 않고(scrollHeight − clientHeight = 0)
  // 여백 16 · 보드 안 세로 스크롤은 그대로(보드에 이 화면 명시 높이 · KanbanBoard h-full이 뿌리를 통째로 먹던 넘침 제거).
  await page.goto('/flow', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="flow-board-frame"]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('details').last().waitFor({ state: 'attached', timeout: 90_000 });
  await page.waitForTimeout(3000);
  const flow = await page.evaluate(() => {
    const det = [...document.querySelectorAll('details')].pop()!;
    const root = det.parentElement!;
    let sc: HTMLElement | null = root;
    while (sc && !/overflow-y-auto/.test(sc.className)) sc = sc.parentElement;
    if (!sc) return null;
    sc.scrollTop = sc.scrollHeight;
    return {
      rootOverflow: root.scrollHeight - root.clientHeight,
      gap: sc.getBoundingClientRect().bottom - det.getBoundingClientRect().bottom,
    };
  });
  // 보드 안 세로 스크롤 유지 — 시드(스토리 셋)로는 칸이 안 넘칠 수 있어 «넘친다»가 아니라 구조를 잰다: 틀 안에 overflow-y auto/scroll 스크롤러가
  // 있고 그 높이가 틀 높이 안으로 묶여 있다(묶여 있어야 내용이 늘면 그 안에서 스크롤된다 · 틀이 없어 뿌리를 따라 늘어나면 묶임이 풀린다).
  const boardInnerScroll = await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="flow-board-frame"]');
    if (!frame) return false;
    const frameH = frame.getBoundingClientRect().height;
    return [...frame.querySelectorAll<HTMLElement>('*')].some((e) => {
      if (!['auto', 'scroll'].includes(getComputedStyle(e).overflowY) || e.getClientRects().length === 0) return false;
      const h = e.getBoundingClientRect().height;
      return h > 200 && h <= frameH + 1;
    });
  }, undefined, { timeout: 30_000 }).then(() => true).catch(() => false);
  expect.soft(flow?.rootOverflow, '일감 뿌리 넘침(scrollHeight − clientHeight)').toBe(0);
  expect.soft(flow?.gap ?? 0, '일감 바닥 상자 ↔ 탭바 여백(px)').toBeGreaterThanOrEqual(12);
  expect.soft(boardInnerScroll, '보드 안 세로 스크롤러(틀 높이 안에 묶임)').toBe(true);
});

