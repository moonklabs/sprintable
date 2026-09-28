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
  // 계측(dev 전용): 디스패치 순간의 계측 범위를 적어 둔다 — 연결 상한으로 풀 줄에 선 요청이 나중에 남의 문맥에서 만들어져도
  // 제 요청에 적히게(server-timing noteDispatch). 계측이 꺼져 있으면 noteDispatch는 바로 돌아간다.
  const dispatch = agent.dispatch.bind(agent);
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
