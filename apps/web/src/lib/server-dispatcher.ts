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
 * - 백엔드 origin(`fastapiBaseUrl()`)만: `allowH2` + 동시 스트림 `pipelining: 100` + 연결 상한 4 — 한 연결에 동시 요청을 싣는다.
 *   undici는 pipelining 기본값 1이면 h2여도 연결을 «바쁨»으로 보고 요청마다 새 연결을 연다(실측 · client.js getPipelining).
 *   외부 origin(Firebase · Google API · OAuth 공급자 등)은 h1일 수 있어 파이프라인을 걸면 한 연결에 줄을 세워 막힐 수 있다 —
 *   그래서 백엔드에만.
 *
 * 판(실측 2026-09-25): 배포 런타임 node:20-alpine = Node 20.20.2 · 내장 undici 6.24.1. npm undici 7은 Node 20 · 22 · 26의
 * 전역 fetch가 이 디스패처를 실제로 쓴다(npm undici 6은 Node 26에서 안 쓰임). 테스트: server-dispatcher.test.ts(실 로컬 서버).
 */
import { Agent, Pool, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

import { fastapiBaseUrl } from './fastapi-url';
import { noteDispatch } from './server-timing';

export const BFF_KEEPALIVE_MS = 60_000;
export const BFF_KEEPALIVE_MAX_MS = 600_000;
/** 백엔드 h2 연결 하나에 싣는 동시 요청 수(GFE · undici 기본 동시 스트림 100). */
export const BACKEND_H2_STREAMS = 100;
/**
 * 백엔드 origin 연결 수 상한. 빈 풀에 동시 요청이 몰리면(기기 콜드 기동) undici는 연결 중인 수만큼 새로 연다 — 상한이 없으면
 * 16건 폭발 = 새 연결 16 · 221ms, 상한 4 = 새 연결 4 · 89ms(node:20 실측 · PO 22:40Z 결정). TLS 손 악수가 1 vCPU 프런트
 * 인스턴스의 CPU를 먹는 몫도 준다. 한 연결에 다 몰지 않는 것(TCP 막힘 · GFE 스트림 100)은 넷으로 나눠 피한다.
 * 주의: 백엔드가 h1으로 내려가면 소켓 4개에 파이프라인으로 줄이 선다 — run.app은 ALPN h2라 없다고 보고, 협상 판은
 * Server-Timing desc `proto=`와 로그 spans에 실어 드러나게 한다(server-timing.ts).
 */
export const BACKEND_CONNECTIONS = 4;

const INSTALLED = Symbol.for('sprintable.bffDispatcher');

function originOf(u: string | URL): string | null {
  try {
    return new URL(String(u)).origin;
  } catch {
    return null;
  }
}

/** `connect`는 테스트(자체 서명 인증서)용 — 운영 설치는 넘기지 않는다. */
export function createBffDispatcher(backendUrl: string, extra: { connect?: Agent.Options['connect'] } = {}): Agent {
  const backend = originOf(backendUrl);
  const agent = new Agent({
    keepAliveTimeout: BFF_KEEPALIVE_MS,
    keepAliveMaxTimeout: BFF_KEEPALIVE_MAX_MS,
    ...extra,
    factory: (origin: string | URL, opts: object) =>
      backend !== null && originOf(origin) === backend
        ? new Pool(origin, { ...(opts as Pool.Options), allowH2: true, pipelining: BACKEND_H2_STREAMS, connections: BACKEND_CONNECTIONS })
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
