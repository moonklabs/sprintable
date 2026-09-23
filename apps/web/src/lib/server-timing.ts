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
  /** 이 호출이 새 연결을 열었는지(false = keep-alive 재사용). 모르면 null. */
  newConnection: boolean | null;
}

interface Collector {
  t0: number;
  spans: TimingSpan[];
}

interface UndiciRequestLike { origin?: unknown; path?: unknown }

const als = new AsyncLocalStorage<Collector>();
const inflight = new WeakMap<object, { collector: Collector; span: TimingSpan; t: number }>();
const seenSockets = new WeakSet<object>();
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
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
      entry.span.newConnection = !seenSockets.has(socket);
      seenSockets.add(socket);
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
  const parts = [`${surface};dur=${totalMs}`];
  spans.forEach((s, i) => {
    const conn = s.newConnection === null ? '?' : s.newConnection ? 'new' : 'reuse';
    parts.push(`be${i}-${s.name};dur=${s.durMs ?? -1};desc="t+${s.startMs} wait=${s.waitMs ?? -1} conn=${conn}"`);
  });
  return parts.join(', ');
}

/** Cloud Logging 한 줄(레이아웃처럼 응답 헤더를 못 다는 자리). 요청 경로·id는 안 싣는다 — 종류 라벨만. */
export function logServerTiming(surface: string, kind: string, totalMs: number, spans: TimingSpan[]): void {
  console.log(JSON.stringify({ message: 'server_timing', surface, kind, totalMs, spans }));
}
