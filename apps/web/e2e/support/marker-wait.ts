// The contrast guard's «wait for the page marker after a reload», moved out of the spec so a real playwright test (marker-wait.4927.layout.spec.ts) can run
// the same code path — the spec itself needs a signed-in full stack. Behaviour of the wait is unchanged (story #3842 · #3839 AC3 · 카디르 QA PR#4265):
//
// story #3842 AC1 — 고정 sleep(1200ms) 제거. 같은 sha에서도 run마다 성패가 갈리던 원인은 (3839 AC3 규명) 스캔 시점 경합: ActivationChecklistBanner가
// useActivationStatus()의 비동기 fetch(/api/activation/checklist)가 끝나야 렌더되는데, 고정 대기는 그 fetch가 CI 네트워크 지연에 따라 끝났는지 여부를
// 무시하고 스캔했다 — 그래서 배너 렌더 有無가 run마다 갈려(有=위반 잡힘·無=거짓 success) 가드 자체가 비결정적이었다. 실 신호(marker)를 기다리는 것으로 그
// 경합을 없앤다 — reload가 호출되기 *전에* waiter를 걸어야 한다(reload 뒤에 걸면 이미 지나간 응답을 놓친다).
// 카디르 QA 발견(PR#4265, 2026-09-14) — 두 분기 다 타임아웃을 .catch로 삼켜 150ms 뒤 그냥 스캔으로 넘어갔다. 이건 경합 창을 1200ms→5000ms로 넓힌 것일 뿐
// 닫은 게 아니다 — 신호가 5초 안에도 안 오면 여전히 배너 그리기 전에 스캔해 거짓 success가 재발할 수 있었다. 처방: 타임아웃이면 삼키지 않고 throw —
// 대비 위반과 구별되는 precondition 메시지로 실패시킨다(신호 자체가 안 왔다는 사실을 "새 대비 위반 없음" 초록과 혼동하지 않게).
//
// story #4927 AC1 — 진단(고침 아님). 마커가 한도 안에 안 오면 «왜 안 왔는지»를 갈라 줄 사실을 오류에 싣는다(marker-diagnostics.ts): 페이지의 요청 · 응답 시각,
// 시간 초과 순간 연결을 쥔 요청(스트림 따로), 그 뒤 더 지켜본 «늦게 온 응답», 같은 구간의 Next 서버 줄(컴파일 시간 등). 한도(5000ms) · 던지는 것 · 메시지 첫 줄은
// 그대로다 — 더 지켜보는 것은 이미 실패가 확정된 뒤의 관찰뿐이고, 진단이 스스로 터져도 원래 오류를 가리지 않는다(아래 safeReport).
import { test, type Page } from '@playwright/test';
import { formatMarkerReport, readServerLog, watchNetwork, type NetworkWatch } from './marker-diagnostics';
import { normalizeRoute, safeErrorName, safeReadyState } from './server-line-allowlist.mjs';

// 두 형만 허용(스펙의 PAGES 표가 페이지마다 하나를 등록한다):
//  ① response  — 그 페이지가 반드시 거치는 비동기 위젯의 fetch 응답을 기다린다.
//  ② networkidle — DashboardShell 밖이라 그 위젯이 없는 페이지(예: /onboarding, 독자 레이아웃 — SSE 연결이 없어 networkidle이 실제로 선다).
export type PageWaitMarker = { kind: 'response'; urlIncludes: string } | { kind: 'networkidle' };

export const PAGE_MARKER_TIMEOUT_MS = 5000; // 근거: #3839 AC3 실측 CI 네트워크 지연 최대 ~2s의 2.5배 여유
export const LATE_WATCH_MAX_MS = 12_000;
const TEST_BUDGET_MARGIN_MS = 8000;

interface Watching { watch: NetworkWatch; startedAt: number }
// the network watch is attached when the test starts (before the first goto) so the old document's streams, still open at reload, are seen too
const WATCHES = new WeakMap<Page, Watching>();

/** Call once at the top of a spec file: every test of the file starts watching its page (and notes when the test began). */
export function installMarkerWatch(): void {
  if (process.env['E2E_NO_WATCH'] === '1') return; // PROOF BRANCH ONLY (story 4927 bisect)
  test.beforeEach(({ page }) => { WATCHES.set(page, { watch: watchNetwork(page), startedAt: Date.now() }); });
}

export interface MarkerWaitOptions { timeoutMs?: number; lateWatchMaxMs?: number }

async function reportMarkerMiss(page: Page, marker: PageWaitMarker, pagePath: string, reloadAt: number, reloadDoneAt: number | null, timeoutMs: number, lateWatchMaxMs: number): Promise<string> {
  const info = test.info();
  const now = Date.now();
  // the response waiter was armed just before the reload and ran out at reloadAt + timeoutMs — a slow reload only made this code run later than that; the networkidle wait starts after the reload, so for it «now» is the miss
  const timedOutAt = marker.kind === 'response' ? Math.min(now, reloadAt + timeoutMs) : now;
  const existing = WATCHES.get(page);
  const watch = existing?.watch ?? watchNetwork(page);
  const testStartedAt = existing?.startedAt ?? reloadAt;
  // never watch past the test's own budget (a timeout of the test would hide this report)
  // (the test's own clock began before the page fixture was made, so keep a wide margin)
  const budget = Math.max(0, Math.min(lateWatchMaxMs, info.timeout - (now - testStartedAt) - TEST_BUDGET_MARGIN_MS));
  let lateIdleAt: number | null = null;
  const watchStartedAt = Date.now();
  if (budget > 0) {
    if (marker.kind === 'networkidle') {
      lateIdleAt = await page.waitForLoadState('networkidle', { timeout: budget }).then(() => Date.now(), () => null);
    } else {
      const done = () => watch.records().some((r) => r.requestAt >= reloadAt && r.path.includes(marker.urlIncludes) && (r.responseAt != null || r.failedAt != null));
      for (let waited = 0; waited < budget && !done(); waited += 250) await page.waitForTimeout(250);
    }
  }
  const watchEndedAt = Date.now(); // the late watch itself (the loop above), before the page state and the log are read
  const dom = await Promise.race([
    page.evaluate(() => ({ readyState: document.readyState, path: location.pathname })).then((d) => `readyState=${safeReadyState(d.readyState)} · path=${normalizeRoute(d.path)}`, () => 'evaluate 실패'),
    new Promise<string>((resolve) => setTimeout(() => resolve('evaluate 2초 안에 답 없음(페이지가 멈춘 듯)'), 2000)),
  ]);
  const server = readServerLog(process.env['E2E_WEBSERVER_LOG']);
  const end = Date.now();
  watch.stop();
  return formatMarkerReport({
    attempt: info.retry + 1,
    pagePath,
    urlIncludes: marker.kind === 'response' ? marker.urlIncludes : null,
    timeoutMs,
    testStartedAt,
    reloadAt,
    timedOutAt,
    reloadDoneAt,
    lateWatchMs: watchEndedAt - watchStartedAt,
    endAt: end,
    lateIdleAt,
    records: watch.records(),
    consoleLines: watch.consoleLines(),
    serverLines: server.lines,
    serverLogAvailable: server.available,
    dom,
  });
}

/** The diagnostics are an add-on to a failure that is already certain: if building them throws, say so and still let the original error through. */
async function safeReport(page: Page, marker: PageWaitMarker, pagePath: string, reloadAt: number, reloadDoneAt: number | null, timeoutMs: number, lateWatchMaxMs: number): Promise<string> {
  try {
    return await reportMarkerMiss(page, marker, pagePath, reloadAt, reloadDoneAt, timeoutMs, lateWatchMaxMs);
  } catch (e) {
    return `── 진단 만들기 실패 (story 4927) ── ${safeErrorName(e instanceof Error ? e.name : '')}`; // the error's NAME only (an error message could carry anything)
  }
}

export async function waitForPageMarker(page: Page, marker: PageWaitMarker, pagePath: string, options: MarkerWaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PAGE_MARKER_TIMEOUT_MS;
  const lateWatchMaxMs = options.lateWatchMaxMs ?? LATE_WATCH_MAX_MS;
  let reloadAt = Date.now();
  let reloadDoneAt: number | null = null;
  try {
    if (marker.kind === 'networkidle') {
      reloadAt = Date.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      reloadDoneAt = Date.now();
      await page.waitForLoadState('networkidle', { timeout: timeoutMs });
    } else {
      const waiter = page.waitForResponse((r) => r.url().includes(marker.urlIncludes), { timeout: timeoutMs });
      waiter.catch(() => {}); // a rejection while reload itself is still running must not become an unhandled one (the awaiting below still throws it)
      reloadAt = Date.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      reloadDoneAt = Date.now();
      await waiter;
    }
  } catch {
    const markerDesc = marker.kind === 'networkidle' ? 'kind:networkidle' : `kind:urlIncludes(${marker.urlIncludes})`;
    const report = await safeReport(page, marker, pagePath, reloadAt, reloadDoneAt, timeoutMs, lateWatchMaxMs);
    throw new Error(`contrast-guard precondition: page marker not seen — ${pagePath} ${markerDesc} within ${timeoutMs}ms\n${report}`);
  }
  // marker 응답/networkidle 도달 뒤 React가 그 데이터를 실제로 commit·페인트할 때까지의
  // 짧은 간극(응답 자체는 렌더 완료를 보장 안 함) — 신호가 안 오면(위에서 throw) 이 스캔
  // 자체를 실패시킨다, 거짓 success로 새지 않는다.
  await page.waitForTimeout(150);
}
