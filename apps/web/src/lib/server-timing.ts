/**
 * story #4219 C1(PO 판정 · 동작 변화 0) — 첫 문서 서버 몫 계측 마커. proxy(/glance 307 · scoped 경로 resolve)와
 * `(authenticated)` 레이아웃 SSR이 요청 하나 동안 내보낸 **백엔드 호출**을 undici diagnostics_channel로 잡아, 호출별
 * 시작 오프셋·총 시간·연결 대기·**연결 새로 엶/재사용**을 남긴다. «Promise.all인데 직렬»·«첫 호출 전 ≈50ms»가 연결
 * 문제인지 가리는 용도 — 그 결과로 연결 풀/keep-alive를 할지 정한다.
 * - 호출 지점은 안 건드린다: 요청 범위(AsyncLocalStorage) 안에서 나간 undici 요청을 전부 모은다.
 * - 이름만(경로 패턴 → 고정 이름) · 시간만. 내부 경로·id·쿼리는 담지 않는다.
 * - dev에서만 켠다: `SERVER_TIMING_MARKERS === 'true'`(cloudbuild dev 분기에서만 주입 · prod 미설정 = 꺼짐).
 *   꺼져 있으면 채널 구독도 ALS도 안 쓴다(오버헤드 0).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';

export function isServerTimingEnabled(): boolean {
  return process.env['SERVER_TIMING_MARKERS'] === 'true';
}

/** 백엔드 경로 → 고정 이름. 모르는 경로는 `other`(경로 원문은 안 남긴다). */
const SPAN_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/v2\/me\/memberships$/, 'me_memberships'],
  [/^\/api\/v2\/me$/, 'me'],
  [/^\/api\/v2\/resolve$/, 'resolve'],
  [/^\/api\/v2\/auth\/refresh$/, 'auth_refresh'],
  [/^\/api\/v2\/organizations$/, 'organizations_list'],
  [/^\/api\/v2\/organizations\/[^/]+$/, 'organization'],
  [/^\/api\/v2\/projects$/, 'projects_list'],
  [/^\/api\/v2\/projects\/[^/]+$/, 'project'],
  [/^\/api\/v2\/activation\/checklist$/, 'activation_checklist'],
  [/^\/api\/v2\/visual-artifacts\/preview$/, 'artifact_preview'],
];

export function spanNameForPath(path: string): string {
  const bare = path.split('?')[0] ?? '';
  return SPAN_NAMES.find(([re]) => re.test(bare))?.[1] ?? 'other';
}

export interface TimingSpan {
  name: string;
  /** 요청(계측 범위) 시작부터 이 호출 시작까지 ms. */
  startMs: number;
  /** 호출 시작 → 응답 끝(본문 수신 완료). 응답이 안 끝났으면 null. */
  durMs: number | null;
  /** 호출 시작 → 요청 헤더 송신(= 연결 확보까지 기다린 시간). */
  waitMs: number | null;
  /** 이 호출이 새 연결을 열었는지 — 소켓 연결 시각이 이 호출 생성 뒤면 true, 전이면(범위 밖 요청이 열어 둔 keep-alive 포함)
   * false. 소켓 정보가 없으면 null. */
  newConnection: boolean | null;
  /** story #4299 AC2 — 이 호출이 탄 연결의 협상 판(TLS ALPN `h2`면 h2 · 그 밖은 h1). 소켓 정보가 없으면 null. 백엔드 연결 풀이
   * h2에서만 한 연결에 동시 요청을 싣는다 — 백엔드가 h1으로 내려가면 연결을 요청마다 따로 쓰게 되니(새 연결 · 대기 증가), 그게
   * 재측 · 로그에서 바로 드러나게 싣는다. */
  proto: 'h2' | 'h1' | null;
}

interface Collector {
  t0: number;
  spans: TimingSpan[];
  /** story #4299 AC2 — 바깥 계측 범위(라우트 전체 · withRouteTiming). 안쪽(proxyToFastapi)에서 나간 백엔드 호출도 바깥에 같이 적는다. */
  parent: Collector | null;
}

interface UndiciRequestLike { origin?: unknown; path?: unknown; method?: unknown }

interface PendingEntry { collector: Collector | null; t: number; taken: boolean }

/**
 * story #4299 AC2 — 계측 상태는 **프로세스에 하나**(globalThis 심볼). Next는 이 모듈을 번들마다 따로 싣는다(prod 빌드 실측:
 * middleware.js · instrumentation 쪽 청크(연결 풀) · 라우트 쪽 청크 — 세 벌). 모듈마다 ALS · 줄 · 구독이 따로면 연결 풀이 적은
 * 디스패치 범위를 라우트 쪽 채널 핸들러가 못 보고, 채널 구독도 벌마다 겹친다. 그래서 ALS · 진행 중 호출 · 소켓 연결 시각 ·
 * 디스패치 줄 · 구독 여부를 한 객체로 두고 모든 벌이 같은 것을 쓴다(구독도 한 번).
 */
interface SharedTimingState {
  als: AsyncLocalStorage<Collector>;
  inflight: WeakMap<object, { spans: TimingSpan[]; t: number }>;
  /** 모든 소켓의 연결 시각(계측 범위와 무관) — 범위 밖 요청(페이지 쪽 fetch · 첫 계측 전 요청)이 열어 쓰던 keep-alive 소켓을
   * «처음 본 소켓 = 새 연결»로 오판하지 않게(PO 리뷰: 재사용률이 낮게 나와 «연결 풀 필요»로 틀리게 기우는 자리). */
  socketConnectedAt: WeakMap<object, number>;
  pendingDispatch: Map<string, PendingEntry[]>;
  subscribed: boolean;
}
const STATE_KEY = Symbol.for('sprintable.serverTiming.state.v1');
const state: SharedTimingState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] as SharedTimingState | undefined) ?? {
  als: new AsyncLocalStorage<Collector>(),
  inflight: new WeakMap(),
  socketConnectedAt: new WeakMap(),
  pendingDispatch: new Map(),
  subscribed: false,
};
(globalThis as Record<symbol, unknown>)[STATE_KEY] = state;
const { als, inflight, socketConnectedAt, pendingDispatch } = state;

/**
 * story #4299 AC2 — 디스패치 순간의 계측 범위. 연결 풀(server-dispatcher)이 백엔드 연결 상한(4)에 걸린 요청을 풀 줄에 세우면,
 * undici는 그 요청을 나중에 **다른 요청의 연결 콜백 문맥**에서 만든다(request:create) — ALS로 범위를 고르면 엉뚱한 요청에 적힌다
 * (prod 빌드 실측: 첫 폭발 16건 중 12건이 첫 요청 헤더에 몰림). 그래서 디스패치할 때(fetch를 부른 문맥 = 맞는 범위)
 * (origin · method · path) 줄에 범위를 적어 두고, request:create에서 그 줄을 먼저 꺼낸다(같은 키는 들어온 순서 — 풀이 FIFO로 꺼낸다).
 * 범위 밖 디스패치도 «범위 없음»(null)으로 적는다 — 줄에서 나중에 만들어질 때 남의 범위를 빌려 쓰지 않게.
 * 만들어지기 전에 끝난 것(오류 · 취소)은 그 순간 줄에서 뺀다(noteDispatch가 돌려주는 cancel — 연결 풀이 handler 오류에 건다).
 * 60초 청소는 안전망이다. 꺼져 있으면(구독 전) 아무것도 안 적는다.
 */
const PENDING_TTL_MS = 60_000;
function dispatchKey(origin: unknown, method: unknown, path: unknown): string | null {
  if (typeof path !== 'string' || (typeof origin !== 'string' && !(origin instanceof URL))) return null;
  let o: string;
  try { o = new URL(String(origin)).origin; } catch { return null; }
  return `${o} ${typeof method === 'string' ? method.toUpperCase() : 'GET'} ${path}`;
}
function sweepPending(now: number): void {
  for (const [key, q] of pendingDispatch) {
    while (q.length && now - q[0]!.t > PENDING_TTL_MS) q.shift();
    if (!q.length) pendingDispatch.delete(key);
  }
}
/**
 * 연결 풀이 dispatch마다 부른다(server-dispatcher). 돌려주는 cancel은 «이 요청이 만들어지기 전에 끝났다»일 때 부른다 —
 * 아직 안 꺼낸 기록이면 줄에서 바로 뺀다(꺼낸 뒤면 아무것도 안 함). 계측이 꺼져 있으면 null(아무것도 안 적음).
 */
export function noteDispatch(opts: { origin?: unknown; method?: unknown; path?: unknown }): (() => void) | null {
  if (!state.subscribed) return null;
  const key = dispatchKey(opts.origin, opts.method, opts.path);
  if (!key) return null;
  const now = performance.now();
  if (pendingDispatch.size > 500) sweepPending(now);
  const q = pendingDispatch.get(key) ?? [];
  const entry: PendingEntry = { collector: als.getStore() ?? null, t: now, taken: false };
  q.push(entry);
  pendingDispatch.set(key, q);
  return () => {
    if (entry.taken) return;
    const cur = pendingDispatch.get(key);
    const i = cur ? cur.indexOf(entry) : -1;
    if (i >= 0) cur!.splice(i, 1);
    if (cur && !cur.length) pendingDispatch.delete(key);
  };
}
/** 디스패치 때 적어 둔 범위(없으면 undefined = 풀을 안 거친 요청 → ALS로). */
function takeDispatch(request: UndiciRequestLike): Collector | null | undefined {
  const key = dispatchKey(request.origin, request.method, request.path);
  const q = key ? pendingDispatch.get(key) : undefined;
  if (!q) return undefined;
  const now = performance.now();
  while (q.length && now - q[0]!.t > PENDING_TTL_MS) q.shift();
  const e = q.shift();
  if (!q.length) pendingDispatch.delete(key!);
  if (!e) return undefined;
  e.taken = true;
  return e.collector;
}

function subscribe(): void {
  if (state.subscribed) return;
  state.subscribed = true;
  diagnosticsChannel.subscribe('undici:client:connected', (msg) => {
    const socket = (msg as { socket?: unknown }).socket;
    if (socket && typeof socket === 'object') socketConnectedAt.set(socket, performance.now());
  });
  diagnosticsChannel.subscribe('undici:request:create', (msg) => {
    const request = (msg as { request?: UndiciRequestLike }).request;
    if (!request || typeof request !== 'object') return;
    const noted = takeDispatch(request);
    const collector = noted === undefined ? als.getStore() : noted;
    if (!collector) return;
    const now = performance.now();
    const name = spanNameForPath(typeof request.path === 'string' ? request.path : '');
    // 안쪽 범위와 바깥 범위(들) 모두에 적는다 — 시작 오프셋은 범위마다 자기 시작 기준.
    const spans: TimingSpan[] = [];
    for (let c: Collector | null = collector; c; c = c.parent) {
      const span: TimingSpan = { name, startMs: Math.round(now - c.t0), durMs: null, waitMs: null, newConnection: null, proto: null };
      c.spans.push(span);
      spans.push(span);
    }
    inflight.set(request, { spans, t: now });
  });
  diagnosticsChannel.subscribe('undici:client:sendHeaders', (msg) => {
    const { request, socket } = msg as { request?: object; socket?: object };
    const entry = request ? inflight.get(request) : undefined;
    if (!entry) return;
    const waitMs = Math.round(performance.now() - entry.t);
    let newConnection: boolean | null = null;
    let proto: TimingSpan['proto'] = null;
    if (socket && typeof socket === 'object') {
      // 연결 시각을 모르면(구독 전에 열린 소켓) 이 요청 전부터 있던 연결 = 재사용.
      const connectedAt = socketConnectedAt.get(socket);
      newConnection = connectedAt !== undefined && connectedAt >= entry.t;
      proto = (socket as { alpnProtocol?: unknown }).alpnProtocol === 'h2' ? 'h2' : 'h1';
    }
    for (const span of entry.spans) {
      span.waitMs = waitMs;
      if (newConnection !== null) span.newConnection = newConnection;
      if (proto !== null) span.proto = proto;
    }
  });
  const finish = (msg: unknown) => {
    const request = (msg as { request?: object }).request;
    const entry = request ? inflight.get(request) : undefined;
    if (!entry) return;
    const durMs = Math.round(performance.now() - entry.t);
    for (const span of entry.spans) span.durMs = durMs;
    inflight.delete(request!);
  };
  diagnosticsChannel.subscribe('undici:request:trailers', finish);
  diagnosticsChannel.subscribe('undici:request:error', finish);
}

export interface TimingResult<T> { value: T; spans: TimingSpan[]; totalMs: number }

/** 계측 범위 안에서 `fn`을 돌리고, 그동안 나간 백엔드 호출 기록을 돌려준다. 꺼져 있으면 spans는 빈 배열. */
export async function withServerTiming<T>(fn: () => Promise<T>): Promise<TimingResult<T>> {
  if (!isServerTimingEnabled()) return { value: await fn(), spans: [], totalMs: 0 };
  subscribe();
  const collector: Collector = { t0: performance.now(), spans: [], parent: als.getStore() ?? null };
  const value = await als.run(collector, fn);
  return { value, spans: collector.spans, totalMs: Math.round(performance.now() - collector.t0) };
}

/** `Server-Timing` 헤더 값 — 이름·시간만(desc는 시작 오프셋·연결 대기·새 연결 여부). */
export function formatServerTiming(surface: string, totalMs: number, spans: TimingSpan[]): string {
  return [`${surface};dur=${totalMs}`, ...spans.map(formatSpan)].join(', ');
}

function formatSpan(s: TimingSpan, i: number): string {
  const conn = s.newConnection === null ? '?' : s.newConnection ? 'new' : 'reuse';
  const proto = s.proto === null ? '?' : s.proto;
  return `be${i}-${s.name};dur=${s.durMs ?? -1};desc="t+${s.startMs} wait=${s.waitMs ?? -1} proto=${proto} conn=${conn}"`;
}

/** Cloud Logging 한 줄(레이아웃처럼 응답 헤더를 못 다는 자리). 요청 경로·id는 안 싣는다 — 종류 라벨만. */
export function logServerTiming(surface: string, kind: string, totalMs: number, spans: TimingSpan[]): void {
  console.log(JSON.stringify({ message: 'server_timing', surface, kind, totalMs, spans }));
}

/**
 * story #4299 — BFF route handler 구간(dev 전용 · 켜져 있을 때만 타이머를 만든다). 동시 요청이 몰리면 BFF 층만 +230~465ms
 * 느는데(백엔드 무변) 그게 어느 구간인지 가르려고, `/api/*` 공용 프록시(proxyToFastapi)가 인증 헤더 · 로케일 · 요청 본문 ·
 * 백엔드 첫 바이트 · 백엔드 본문 구간과 백엔드 호출의 연결 대기 · 새 연결 여부를 낸다. 미들웨어가 들어올 때 찍은
 * 시각(MW_T0_HEADER · 같은 프로세스 벽시계)으로 «미들웨어 + 라우트까지 대기»(bff_pre)도 낸다. 이름 · 시간만(경로 · id 0).
 */
export const MW_T0_HEADER = 'x-sp-mw-t0';

export interface RouteTimingSummary {
  totalMs: number;
  /** 미들웨어 시작 → 이 타이머 시작. 표시 헤더가 없거나 이상하면(음수 · 1분 초과) null. */
  preMs: number | null;
  marks: Array<[string, number]>;
}

export interface RouteTimer {
  /** 직전 표시(또는 시작)부터 지금까지를 name 구간으로 적는다. */
  mark(name: string): void;
  summary(): RouteTimingSummary;
}

export function startRouteTimer(request: Request, now: () => number = () => performance.now(), wall: () => number = Date.now): RouteTimer {
  const t0 = now();
  const mwT0 = Number(request.headers.get(MW_T0_HEADER) ?? NaN);
  const pre = wall() - mwT0;
  const preMs = Number.isFinite(pre) && pre >= 0 && pre <= 60_000 ? Math.round(pre) : null;
  const marks: Array<[string, number]> = [];
  let last = t0;
  return {
    mark(name) {
      const t = now();
      marks.push([name, Math.round(t - last)]);
      last = t;
    },
    summary: () => ({ totalMs: Math.round(now() - t0), preMs, marks: [...marks] }),
  };
}

/** `bff;dur=합계, bff_pre;dur=…, bff_<구간>;dur=…, be0-<이름>;dur=…;desc="… wait=… conn=…"` */
export function formatRouteTiming(s: RouteTimingSummary, spans: TimingSpan[]): string {
  return [
    `bff;dur=${s.totalMs}`,
    ...(s.preMs === null ? [] : [`bff_pre;dur=${s.preMs};desc="mw+queue"`]),
    ...s.marks.map(([name, dur]) => `bff_${name};dur=${dur}`),
    ...spans.map(formatSpan),
  ].join(', ');
}

/**
 * 백엔드 경로 → 리소스 이름(`v2/labels` · 더 깊은 칸은 개수만 `v2/stories/+2`). id · slug · 쿼리는 안 남긴다.
 * 로그로 새는 «종류»를 모양으로 막는다(까디르 4652): 버전 칸은 `v숫자`만, 리소스 칸은 소문자 · `_` · `-`만(숫자 · `@` · `.` 없음)
 * 통과하고 나머지는 전부 `other` — 이메일 · uuid · 숫자 id가 어느 칸에 와도 이름으로 안 실린다.
 */
const VERSION_SEG = /^v\d+$/;
const RESOURCE_SEG = /^[a-z][a-z_-]*$/;
export function routeKindForPath(fastapiPath: string): string {
  const segs = (fastapiPath.split('?')[0] ?? '').split('/').filter(Boolean);
  const version = segs[1] ?? '';
  const resource = segs[2] ?? '';
  if (segs[0] !== 'api' || !VERSION_SEG.test(version) || !RESOURCE_SEG.test(resource)) return 'other';
  const rest = segs.length - 3;
  return `${version}/${resource}${rest > 0 ? `/+${rest}` : ''}`;
}

/** 응답을 새로 감싸는 라우트(sprints 등)는 헤더가 안 남는다 — 서버 로그 한 줄로도 남겨 PO가 요청 로그와 맞춘다. */
export function logRouteTiming(kind: string, status: number, s: RouteTimingSummary, spans: TimingSpan[]): void {
  console.log(JSON.stringify({ message: 'server_timing', surface: 'bff', kind, status, ...s, spans }));
}

/**
 * story #4299 AC2 — 라우트 전체 계측. 응답을 새로 만드는 라우트(`apiSuccess`로 다시 감쌈 · 저장소 경유 fastapiCall ·
 * 인증 `/api/v2/me` 선행)는 proxyToFastapi가 단 헤더가 안 남거나 그 밖의 백엔드 호출이 안 보인다. 라우트 전체를 감싸
 * 합계(bff) · bff_pre · 그 사이 나간 **모든** 백엔드 호출(인증 /me · 안쪽 proxyToFastapi 포함 — 바깥 범위에도 적힘)을 싣고,
 * 같은 값을 로그 한 줄(kind `route/<이름>`)로도 남긴다. 꺼져 있으면 handler를 그대로 부른다(타이머 · 계측 범위 · 로그 0).
 */
export function withRouteTiming<A extends unknown[]>(
  kind: string,
  handler: (request: Request, ...rest: A) => Promise<Response>,
): (request: Request, ...rest: A) => Promise<Response> {
  return async (request: Request, ...rest: A): Promise<Response> => {
    if (!isServerTimingEnabled()) return handler(request, ...rest);
    const timer = startRouteTimer(request);
    const { value: response, spans } = await withServerTiming(() => handler(request, ...rest));
    const summary = timer.summary();
    try {
      response.headers.set('Server-Timing', formatRouteTiming(summary, spans));
    } catch {
      // 불변 헤더 응답이면 헤더는 건너뛰고 로그만.
    }
    logRouteTiming(`route/${kind}`, response.status, summary, spans);
    return response;
  };
}

// 켜져 있으면 모듈 로드 시점에 구독 — 첫 계측 전에 열린 연결의 시각도 잡는다(꺼져 있으면 구독 0).
if (isServerTimingEnabled()) subscribe();
