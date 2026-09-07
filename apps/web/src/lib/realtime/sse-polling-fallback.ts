'use client';

/**
 * story #3621(FE·결함·high, 선생님 2026-09-07 05:45Z 실물) — SSE가 `connected=false`로
 * 일정 시간(threshold) 이상 머물면 폴링으로 전환해 화면이 "스스로" 낡음을 벗어나게
 * 한다. 실시간 게이트웨이가 죽어 있던 15시간 동안(story #3616) 화면이 조용히 낡은
 * 채 서 있었고, 방을 옮기는(=페이지 fetch) 사람 조작 없이는 새 메시지가 안 보였다 —
 * 그 갭을 없앤다.
 *
 * 이 모듈은 "다음 폴 간격이 얼마여야 하는지"(연속 실패마다 배로 늘어 상한까지, 성공하면
 * 기본값으로 복귀)만 판정하는 순수 상태기계다 — sse-reconnect-backoff.ts와 동일 분리
 * 원칙(스케줄링·threshold·visibility 게이팅은 호출부 useChatSse가 쥔다, React 없이
 * 단위테스트 가능).
 */
export const POLL_THRESHOLD_MS = 10_000;
export const POLL_INTERVAL_MS = 15_000;
export const POLL_MAX_INTERVAL_MS = 30_000;

export interface PollBackoffState {
  /** 다음 폴 간격(ms). */
  currentIntervalMs: () => number;
  /** 폴 시도 완료 후 호출 — 성공(true)이면 기본 간격으로 복귀, 실패(false)면 배로
   *  늘어(상한까지) — "네트워크 자체가 죽었으면 더 자주 두드릴 이유가 없다". */
  onPollResult: (ok: boolean) => void;
}

export function createPollBackoffState(
  options: { intervalMs?: number; maxIntervalMs?: number } = {},
): PollBackoffState {
  const baseIntervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? POLL_MAX_INTERVAL_MS;
  let intervalMs = baseIntervalMs;

  return {
    currentIntervalMs() {
      return intervalMs;
    },
    onPollResult(ok) {
      intervalMs = ok ? baseIntervalMs : Math.min(intervalMs * 2, maxIntervalMs);
    },
  };
}
