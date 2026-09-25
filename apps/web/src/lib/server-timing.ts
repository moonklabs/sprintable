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
}

interface Collector {
  t0: number;
  spans: TimingSpan[];
}

interface UndiciRequestLike { origin?: unknown; path?: unknown }

const als = new AsyncLocalStorage<Collector>();
const inflight = new WeakMap<object, { collector: Collector; span: TimingSpan; t: number }>();
// 모든 소켓의 연결 시각(계측 범위와 무관) — 범위 밖 요청(페이지 쪽 fetch · 첫 계측 전 요청)이 열어 쓰던 keep-alive 소켓을
// «처음 본 소켓 = 새 연결»로 오판하지 않게(PO 리뷰: 재사용률이 낮게 나와 «연결 풀 필요»로 틀리게 기우는 자리).
const socketConnectedAt = new WeakMap<object, number>();
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  diagnosticsChannel.subscribe('undici:client:connected', (msg) => {
    const socket = (msg as { socket?: unknown }).socket;
    if (socket && typeof socket === 'object') socketConnectedAt.set(socket, performance.now());
  });
  diagnosticsChannel.subscribe('undici:request:create', (msg) => {
    const collector = als.getStore();
    const request = (msg as { request?: UndiciRequestLike }).request;
    if (!collector || !request || typeof request !== 'object') return;
    const now = performance.now();
    const span: TimingSpan = {
      name: spanNameForPath(typeof request.path === 'string' ? request.path : ''),
      startMs: Math.round(now - collector.t0), durMs: null, waitMs: null, newConnection: null,
    };
    collector.spans.push(span);
    inflight.set(request, { collector, span, t: now });
  });
  diagnosticsChannel.subscribe('undici:client:sendHeaders', (msg) => {
    const { request, socket } = msg as { request?: object; socket?: object };
    const entry = request ? inflight.get(request) : undefined;
    if (!entry) return;
    entry.span.waitMs = Math.round(performance.now() - entry.t);
    if (socket && typeof socket === 'object') {
      // 연결 시각을 모르면(구독 전에 열린 소켓) 이 요청 전부터 있던 연결 = 재사용.
      const connectedAt = socketConnectedAt.get(socket);
      entry.span.newConnection = connectedAt !== undefined && connectedAt >= entry.t;
    }
  });
  const finish = (msg: unknown) => {
    const request = (msg as { request?: object }).request;
    const entry = request ? inflight.get(request) : undefined;
    if (!entry) return;
    entry.span.durMs = Math.round(performance.now() - entry.t);
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
  const collector: Collector = { t0: performance.now(), spans: [] };
  const value = await als.run(collector, fn);
  return { value, spans: collector.spans, totalMs: Math.round(performance.now() - collector.t0) };
}

/** `Server-Timing` 헤더 값 — 이름·시간만(desc는 시작 오프셋·연결 대기·새 연결 여부). */
export function formatServerTiming(surface: string, totalMs: number, spans: TimingSpan[]): string {
  return [`${surface};dur=${totalMs}`, ...spans.map(formatSpan)].join(', ');
}

function formatSpan(s: TimingSpan, i: number): string {
  const conn = s.newConnection === null ? '?' : s.newConnection ? 'new' : 'reuse';
  return `be${i}-${s.name};dur=${s.durMs ?? -1};desc="t+${s.startMs} wait=${s.waitMs ?? -1} conn=${conn}"`;
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

// 켜져 있으면 모듈 로드 시점에 구독 — 첫 계측 전에 열린 연결의 시각도 잡는다(꺼져 있으면 구독 0).
if (isServerTimingEnabled()) subscribe();
