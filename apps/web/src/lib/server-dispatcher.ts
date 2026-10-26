/**
 * story #4299 AC2 — BFF 서버 fetch 공유 연결 풀(전역 undici 디스패처 · instrumentation register에서 한 번).
 *
 * 왜: 기기 콜드 기동(요청 9건이 15ms 안에 동시 출발)에서 BFF → 백엔드 호출 27건 중 15건이 새 연결을 열었고, 그 연결 대기
 * (DNS · TCP · TLS)가 중앙 103ms(55~187)였다(doc: 4299 AC1 쿠키 경로 판). Node 내장 fetch의 기본 디스패처는 keep-alive가
 * 4초라 요청 사이가 조금만 벌어져도 연결을 닫고, h2를 안 써 동시 요청마다 연결을 따로 연다. 이 대기는 서버 로그에서 BFF
 * 지연에만 들고 백엔드 지연에는 안 든다(카드의 «BFF만 늘고 백엔드 무변» 모양).
 *
 * 무엇:
 * - 모든 origin: keep-alive 60초(최대 10분 — GFE 유휴 끊김 약 10분보다 짧게). 파이프라인 없음(pipelining 1 · h1).
 * - 백엔드 origin(`fastapiBaseUrl()`)만: `allowH2` + **h2에서만** 한 연결에 동시 요청(연결 수 상한은 없음 — 아래 PO 판단).
 *   undici는 pipelining 옵션을 안 주면 1로 고정해 h2여도 연결을 «바쁨»으로 보고 요청마다 새 연결을 연다(실측 · client.js
 *   getPipelining). 그래서 Client를 만든 뒤 pipelining을 비워 **협상 판 기본값**을 쓰게 한다: h2 = 한 연결에 여러 요청 · h1 = 한 번에
 *   하나. h1에서 파이프라인을 걸면 끝나지 않는 응답(SSE — REALTIME_URL이 비면 /api/event-stream도 백엔드 origin) 뒤에 다른 요청이
 *   줄 서서 영영 안 끝난다(CI 평문 백엔드에서 실제로 걸림 · 4699 Contrast guard).
 *   외부 origin(Firebase · Google API · OAuth 공급자 등)은 기본 그대로(keep-alive만).
 *
 * 판(실측 2026-09-25): 배포 런타임 node:20-alpine = Node 20.20.2 · 내장 undici 6.24.1. npm undici 7은 Node 20 · 22 · 26의
 * 전역 fetch가 이 디스패처를 실제로 쓴다(npm undici 6은 Node 26에서 안 쓰임). 테스트: server-dispatcher.test.ts(실 로컬 서버).
 */
import { Agent, Client, Pool, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

import { fastapiBaseUrl } from './fastapi-url';
import { noteDispatch } from './server-timing';

export const BFF_KEEPALIVE_MS = 60_000;
export const BFF_KEEPALIVE_MAX_MS = 600_000;
// 연결 수 상한은 두지 않는다(PO 2026-09-26 00:48Z). 상한은 «빈 풀 첫 폭발» 손 악수만 줄이는데(16 → 4), h1 백엔드(평문 CI · 로컬 ·
// 자체 호스트)에서는 끝나지 않는 SSE 몇 개가 연결을 다 잡아 나머지가 막히는 새 실패 부류를 만든다. keep-alive가 긴 운영에서는 폴링이
// 풀을 데워 두어 빈 풀이 드물다. 첫 폭발 비용이 재측에서 크면 다른 방법(기동 때 연결 예열 등)으로 가른다.

const INSTALLED = Symbol.for('sprintable.bffDispatcher');

function originOf(u: string | URL): string | null {
  try {
    return new URL(String(u)).origin;
  } catch {
    return null;
  }
}

/**
 * `connect` · `backendConnections`는 테스트용 — 운영 설치(installBffDispatcher)는 넘기지 않는다.
 * `backendConnections`는 백엔드 풀에 연결 상한을 걸어 **요청이 풀 줄에 서는 판**을 일부러 만든다(줄 선 요청의 계측 범위 테스트).
 */
export function createBffDispatcher(
  backendUrl: string,
  extra: { connect?: Agent.Options['connect']; backendConnections?: number } = {},
): Agent {
  const backend = originOf(backendUrl);
  const { backendConnections, ...agentExtra } = extra;
  const agent = new Agent({
    keepAliveTimeout: BFF_KEEPALIVE_MS,
    keepAliveMaxTimeout: BFF_KEEPALIVE_MAX_MS,
    ...agentExtra,
    factory: (origin: string | URL, opts: object) =>
      backend !== null && originOf(origin) === backend
        ? new Pool(origin, { ...(opts as Pool.Options), allowH2: true, connections: backendConnections, factory: protocolPipeliningClient })
        : new Pool(origin, opts as Pool.Options),
  });
  // story #4723 — 본문이 있는 DELETE는 h1로 보낸다. undici h2는 DELETE(PUT · POST · PATCH만 «본문을 기대»하는 메서드로 본다 ·
  // client-h2.js expectsPayload)에는 content-length를 안 달고, 길이 없는 h2 DATA는 Cloud Run 앞단(GFE)을 지나며 백엔드에 «본문 없음»으로
  // 닿는다(dev 실측: 설정 → 조직 삭제 DELETE /api/organizations/{id} 가 422 body missing). undici h1은 길이를 단다.
  // (story 4786부터 DELETE를 포함한 모든 멱등이 아닌 요청이 h1이라 이 경우는 아래 규칙에 들어간다 — `isBodyDeleteToBackend`는 그 분류를
  // 따로 시험하는 데 남아 있고 여기 분기에서는 더 안 부른다.) 전제: 백엔드가 h1도 받는다(Cloud Run · 평문 CI · 로컬 모두 그렇다) —
  // h2 전용 백엔드를 두게 되면 멱등이 아닌 요청은 이 경로에서 막힌다(그때 이 전제를 다시 본다).
  // story 4786 — 백엔드 origin에서 h2는 «멱등한 요청(GET · HEAD)»에만 쓴다. 멱등이 아닌 요청(POST · PUT · PATCH · DELETE · OPTIONS)과 브라우저
  // 이벤트 스트림(GET /api/v2/events/stream)은 h1으로 보낸다. 이유: undici h2 `busy()`(client-h2.js)는 진행 중인 요청이 하나라도 있으면 멱등이
  // 아닌 요청을 그 연결에 받지 않는다. 그래서 (a) 끝나지 않는 응답(SSE)이 h2 연결에 앉으면 그 연결로는 POST가 영영 못 나가고, (b) 느린 POST
  // 하나가 같은 연결의 다른 POST를 막는다 — «로그인 · 갱신 · 메시지 보내기만 30초 뒤 503, 읽기는 정상»(dev 실측 10-26: REALTIME_URL을 비워
  // 스트림이 백엔드 origin으로 온 직후. (b)는 prod BFF에도 있던 길이다). h2의 이득(콜드 기동 때 새 연결 대기 · SID 4299)은 GET 묶음에서 나온다.
  // h1은 연결마다 요청 하나라 서로 막지 않는다(느린 요청 · 스트림이 연결을 하나씩 차지하고 다른 요청은 새 연결로 나간다).
  let h1Agent: Agent | null = null;
  const h1 = () => (h1Agent ??= new Agent({ keepAliveTimeout: BFF_KEEPALIVE_MS, keepAliveMaxTimeout: BFF_KEEPALIVE_MAX_MS, ...agentExtra }));
  const agentDispatch = agent.dispatch.bind(agent);
  // 이미 닫혔거나 부서졌으면 h1을 새로 만들지 않고 원 Agent로 보낸다 — 거기서 «닫힘» 오류가 제대로 난다.
  const dispatch = (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) =>
    !agent.closed && !agent.destroyed && isH1OnlyToBackend(opts, backend)
      ? h1().dispatch(opts, handler)
      : agentDispatch(opts, handler);
  // 닫을 때 h1 쪽도 같이 닫는다. 원 Agent의 close/destroy를 «바로» 부른다(닫힘 표시가 그 자리에서 서므로, 닫는 중에 온 본문 DELETE가 h2로
  // 새어 본문을 잃지 않고 «닫힘» 오류가 난다) — h1은 그와 나란히 닫는다. undici의 close/destroy는 콜백이 없으면 안에서 `this.destroy(err, cb)`를
  // 다시 부르므로(promise 판), 이 덧씌움은 원본을 항상 «콜백 판»으로 부른다 — 안 그러면 자기 자신을 끝없이 부른다.
  type Lifecycle = (...args: unknown[]) => unknown;
  const alsoH1 = (base: Lifecycle, side: (args: unknown[]) => Promise<unknown> | undefined): Lifecycle => (...args) => {
    const sideDone = Promise.resolve(side(args)).catch(() => undefined);
    const cbAt = args.findIndex((a) => typeof a === 'function');
    if (cbAt !== -1) {
      // 콜백 판: 부르는 쪽 콜백은 원 Agent와 h1이 둘 다 끝난 뒤에 불린다.
      const next = [...args];
      const cb = args[cbAt] as (...r: unknown[]) => void;
      next[cbAt] = (...r: unknown[]) => { void sideDone.then(() => cb(...r)); };
      base(...next);
      return undefined;
    }
    const baseDone = new Promise<void>((resolve, reject) => { base(...args, (err: Error | null) => (err ? reject(err) : resolve())); });
    return Promise.all([sideDone, baseDone]).then(() => undefined);
  };
  agent.close = alsoH1(agent.close.bind(agent) as Lifecycle, () => h1Agent?.close()) as typeof agent.close;
  agent.destroy = alsoH1(agent.destroy.bind(agent) as Lifecycle, (args) => h1Agent?.destroy(typeof args[0] === 'function' ? null : ((args[0] as Error | null | undefined) ?? null))) as typeof agent.destroy;
  // 계측(dev 전용): 디스패치 순간의 계측 범위를 적어 둔다 — 연결 상한으로 풀 줄에 선 요청이 나중에 남의 문맥에서 만들어져도
  // 제 요청에 적히게(server-timing noteDispatch). 계측이 꺼져 있으면 noteDispatch는 바로 돌아간다.
  agent.dispatch = ((opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
    const cancel = noteDispatch(opts);
    if (!cancel) return dispatch(opts, handler); // 계측 꺼짐 — handler를 건드리지 않는다
    try {
      return dispatch(opts, cancelOnError(handler, cancel));
    } catch (err) {
      cancel();
      throw err;
    }
  }) as typeof agent.dispatch;
  return agent;
}

/** 요청 머리에서 한 값(대소문자 무시). undici는 object · [k, v, k, v …] · Iterable 셋 다 받는다. */
function headerOf(headers: Dispatcher.DispatchOptions['headers'], name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) if (String(headers[i]).toLowerCase() === lower) return String(headers[i + 1]);
    return null;
  }
  // 한 번 읽으면 끝나는 Iterable(제너레이터 등)은 여기서 읽지 않는다 — undici가 같은 머리를 뒤에 다시 읽는다. 길이를 모르는 것으로 본다.
  if (Symbol.iterator in headers) return null;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[]>)) if (k.toLowerCase() === lower) return String(Array.isArray(v) ? v[0] : v);
  return null;
}

/**
 * 백엔드 origin으로 가는, 본문이 실제로 있는 DELETE. 전역 fetch는 본문 `''`도 «빈 스트림 + content-length: 0»으로 바꿔 넘기므로(프록시는
 * DELETE에도 `request.text()`를 싣는다 — 본문 없는 DELETE 47곳이 거의 전부 이 모양) 길이 0은 본문 없음으로 본다. 길이를 모르는 스트림은 본문 있음.
 */
export function isBodyDeleteToBackend(opts: Dispatcher.DispatchOptions, backend: string | null): boolean {
  if (backend === null || String(opts.method).toUpperCase() !== 'DELETE') return false;
  if (opts.body == null || opts.body === '') return false;
  if ((opts.body as { byteLength?: number }).byteLength === 0) return false; // 빈 Buffer · 빈 typed array
  if (headerOf(opts.headers, 'content-length') === '0') return false;
  return originOf(opts.origin as string | URL) === backend;
}

/** 백엔드의 브라우저 이벤트 스트림 경로(apps/web/src/app/api/event-stream/route.ts가 부르는 곳). */
export const BACKEND_EVENT_STREAM_PATH = '/api/v2/events/stream';

/**
 * 백엔드 origin으로 가는 이벤트 스트림 GET — 끝나지 않는 응답이라 h2 한 연결에 앉으면 그 연결로는 멱등이 아닌 요청이 못 나간다(위 설명).
 * 경로는 쿼리를 뗀 뒤 정확히 비교한다(`?member_id=…` · `?last_event_id=…`가 붙어 온다).
 */
export function isEventStreamToBackend(opts: Dispatcher.DispatchOptions, backend: string | null): boolean {
  if (backend === null || String(opts.method).toUpperCase() !== 'GET') return false;
  if (String(opts.path).split('?')[0] !== BACKEND_EVENT_STREAM_PATH) return false;
  return originOf(opts.origin as string | URL) === backend;
}

/** undici가 «멱등»으로 보는 메서드(core/request.js: GET · HEAD) 밖 전부 — POST · PUT · PATCH · DELETE · OPTIONS. h2 `busy()`가 진행 중 요청이 있으면 받지 않는 요청. */
export function isNonIdempotentMethod(method: string | undefined): boolean {
  const m = String(method).toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}

/** 백엔드 origin으로 가는 요청 중 h2에 태우지 않는 것: 멱등이 아닌 요청 + 이벤트 스트림. 그 밖의 GET · HEAD만 h2(한 연결에 여러 요청). */
export function isH1OnlyToBackend(opts: Dispatcher.DispatchOptions, backend: string | null): boolean {
  if (backend === null || originOf(opts.origin as string | URL) !== backend) return false;
  return isNonIdempotentMethod(opts.method) || isEventStreamToBackend(opts, backend);
}

/**
 * handler의 오류 콜백(옛 onError · 새 onResponseError)만 가로채 cancel을 먼저 부르고 원래 것을 그대로 부른다. 나머지 속성 ·
 * 메서드는 원 handler에 묶어 그대로 넘긴다(this · 있는지 여부 무변). 요청이 만들어진 뒤의 오류면 cancel은 아무것도 안 한다.
 */
function cancelOnError(handler: Dispatcher.DispatchHandler, cancel: () => void): Dispatcher.DispatchHandler {
  return new Proxy(handler, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'onError' || prop === 'onResponseError') {
        return (...args: unknown[]) => {
          cancel();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/**
 * pipelining을 비운 Client — undici가 협상 판 기본값(h2 = 한 연결에 여러 요청 · h1 = 한 번에 하나 · 연결 전 = 하나)을 쓴다.
 * h1에서는 절대 파이프라인하지 않는다(끝나지 않는 응답 뒤 줄 섬 방지).
 */
function protocolPipeliningClient(origin: string | URL, opts: object): Client {
  const client = new Client(origin, opts as Client.Options);
  (client as unknown as { pipelining: number | undefined }).pipelining = undefined;
  return client;
}

/** 전역 디스패처를 한 번만 바꾼다(이미 우리 것이면 그대로). 반환 = 지금 전역 디스패처. */
export function installBffDispatcher(backendUrl: string = fastapiBaseUrl()): Dispatcher {
  const current = getGlobalDispatcher() as Dispatcher & { [INSTALLED]?: string };
  if (current[INSTALLED]) return current;
  const agent = createBffDispatcher(backendUrl) as Agent & { [INSTALLED]?: string };
  agent[INSTALLED] = originOf(backendUrl) ?? '';
  setGlobalDispatcher(agent);
  return agent;
}

/** 지금 전역 디스패처가 이 모듈이 설치한 것인지(설치한 백엔드 origin · 아니면 null). */
export function installedBackendOrigin(): string | null {
  const current = getGlobalDispatcher() as Dispatcher & { [INSTALLED]?: string };
  return current[INSTALLED] ?? null;
}
