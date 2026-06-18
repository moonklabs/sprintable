// AC3(af8d3641): graceful 세션-만료 redirect 계약. 인증 실패 redirect 는 전부
// `/login?next=<enc>&reason=session_expired` 로 통일 — login 이 reason 배너 + next 복귀(작업 손실
// 최소화)에 사용. server(proxy·layout)·client(fetchWithAuth) 공용 순수 함수.

export const SESSION_EXPIRED_REASON = 'session_expired';

/** 현재 경로(pathname+search)를 next 로 보존한 /login redirect 경로. */
export function buildLoginRedirect(currentPathAndSearch: string): string {
  const target = currentPathAndSearch && currentPathAndSearch.startsWith('/') ? currentPathAndSearch : '/inbox';
  return `/login?next=${encodeURIComponent(target)}&reason=${SESSION_EXPIRED_REASON}`;
}

/**
 * 오픈 리다이렉트 가드 — next 가 **내부 절대경로**(`/` 시작·`//`(프로토콜-상대)·`/\` 아님)일 때만 허용,
 * 아니면 `/inbox`. login 성공/콜백 복귀 시 외부 도메인 유도(`//evil.com`·`http://`)를 차단.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/inbox';
  let decoded: string;
  try { decoded = decodeURIComponent(next); } catch { return '/inbox'; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) return '/inbox';
  return decoded;
}
