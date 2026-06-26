/**
 * 멀티계정 switch epoch (bf305fa0·RC2 stale Set-Cookie suppression).
 *
 * 문제: switch(A→B) 직전에 시작된 A 계정의 늦은 refresh 응답이, switch 後 도착해
 * `applyTokenCookies`로 sp_at/sp_rt 를 A 로 되돌릴 수 있다. request cookie snapshot 비교만으로는
 * 늦은 요청의 snapshot 에도 old pointer 가 있어 결정적으로 못 막는다.
 *
 * 해법: switch/sign-out 시 "떠난 계정"을 server-authoritative 하게 superseded 마킹.
 * middleware 가 refresh 결과 sub 가 최근 superseded 면 Set-Cookie 억제 → snapshot 무관 결정적 차단.
 *
 * 범위: in-instance(module state). serverless 다중 인스턴스 잔여 race 는 BE single-use RT rotation
 * (떠난 계정 RT 가 한 번 쓰이면 무효)이 backstop. TTL window 로 메모리 bound.
 */
const SUPERSEDE_TTL_MS = 30_000;
const superseded = new Map<string, number>(); // accountId → supersededAt(ms)

/** switch/sign-out 으로 떠난 계정 마킹 — 이후 그 계정의 stale refresh Set-Cookie 억제. */
export function markSuperseded(accountId: string): void {
  const now = Date.now();
  superseded.set(accountId, now);
  if (superseded.size > 256) {
    for (const [k, v] of superseded) if (v + SUPERSEDE_TTL_MS <= now) superseded.delete(k);
  }
}

/**
 * 계정이 다시 active 가 될 때(switch TO) 마킹 해제 — RC3 switch-back 보존.
 * A→B(A superseded)→A 빠른 복귀 시 A 마킹을 지워 A 의 정상 refresh 가 억제되지 않게 한다.
 */
export function clearSuperseded(accountId: string): void {
  superseded.delete(accountId);
}

/** 해당 계정이 최근(TTL 내) switch 로 superseded 되었는지 — middleware refresh 억제 판정. */
export function isRecentlySuperseded(accountId: string): boolean {
  const t = superseded.get(accountId);
  if (t === undefined) return false;
  if (t + SUPERSEDE_TTL_MS <= Date.now()) {
    superseded.delete(accountId);
    return false;
  }
  return true;
}
