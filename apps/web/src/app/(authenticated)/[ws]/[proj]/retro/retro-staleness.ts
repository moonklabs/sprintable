// story #2413 — 실측(2026-08-02): "회고제목"(action, 2026-07-01부터 멈춤)·투표 2건(vote,
// 2026-07-01부터 멈춤)이 실제 회고 목록과 나란히, 아무 표시 없이 서 있었다. closed가 아닌
// phase가 얼마나 오래 안 움직였는지 화면이 말해야 한다(자동 전이 아님 — 판단은 사람 몫).
// 기준일 14일 — 이 프로젝트의 스프린트 길이가 대부분 1~2주라, 그 한 주기보다 오래 멈춰
// 있으면 "다음 회고 전까지도 그대로일" 신호로 본다.
//
// 별도 모듈로 뺀 이유 — page.tsx(Next.js App Router 페이지)는 default export 외 임의의
// named export를 허용하지 않는다("X is not a valid Page export field" 빌드 에러).
const RETRO_STALE_THRESHOLD_DAYS = 14;

export function isRetroStale(session: { phase: string; updated_at: string }, now: Date): boolean {
  if (session.phase === 'closed') return false;
  return daysStale(session.updated_at, now) >= RETRO_STALE_THRESHOLD_DAYS;
}

export function daysStale(updatedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(updatedAt)) / 86_400_000));
}
