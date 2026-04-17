/**
 * In-memory rate limiter (에이전트용)
 *
 * 정책 §14.3: 에이전트당 300 req/min
 *
 * 프로덕션 환경에서는 Redis 등을 사용해야 하지만,
 * 초기 구현은 메모리 기반으로 간단하게 처리.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60 * 1000; // 1분
const MAX_REQUESTS_PER_WINDOW = 300;

// team_member_id → RateLimitEntry
const rateLimitMap = new Map<string, RateLimitEntry>();

/**
 * Rate limit 체크
 *
 * @param teamMemberId - team_member.id (에이전트)
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(teamMemberId: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  const entry = rateLimitMap.get(teamMemberId);

  // 1. 기존 entry가 없거나 window 만료 → 새 window 시작
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    rateLimitMap.set(teamMemberId, {
      count: 1,
      windowStart: now,
    });

    return {
      allowed: true,
      remaining: MAX_REQUESTS_PER_WINDOW - 1,
      resetAt: now + WINDOW_MS,
    };
  }

  // 2. Window 내에서 카운트 증가
  entry.count += 1;

  const allowed = entry.count <= MAX_REQUESTS_PER_WINDOW;
  const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - entry.count);
  const resetAt = entry.windowStart + WINDOW_MS;

  return { allowed, remaining, resetAt };
}

/**
 * Rate limit 초기화 (테스트용)
 */
export function resetRateLimits() {
  rateLimitMap.clear();
}

/**
 * 주기적으로 오래된 entry 정리 (메모리 누수 방지)
 *
 * 프로덕션에서는 cron으로 실행하거나,
 * Redis TTL을 사용하는 것을 권장.
 */
export function cleanupExpiredEntries() {
  const now = Date.now();
  const keysToDelete: string[] = [];

  rateLimitMap.forEach((entry, key) => {
    if (now - entry.windowStart >= WINDOW_MS * 2) {
      keysToDelete.push(key);
    }
  });

  for (const key of keysToDelete) {
    rateLimitMap.delete(key);
  }
}

// 5분마다 cleanup (optional)
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpiredEntries, 5 * 60 * 1000);
}
