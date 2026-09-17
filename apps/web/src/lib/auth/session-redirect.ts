// AC3(af8d3641): graceful 세션-만료 redirect 계약. 인증 실패 redirect 는 전부
// `/login?next=<enc>&reason=session_expired` 로 통일 — login 이 reason 배너 + next 복귀(작업 손실
// 최소화)에 사용. server(proxy·layout)·client(fetchWithAuth) 공용 순수 함수.

export const SESSION_EXPIRED_REASON = 'session_expired';

// story #4017(PO 확定 2026-09-17) — chatV3Enabled 인자로 기본 착지를 목적지 모듈과
// 정렬(OFF=/chats 그대로, ON=/chat). 이 파일은 server(proxy·layout)·client(fetchWithAuth)
// 공용 순수 함수라 process.env를 직접 안 읽고, 호출부가 자기 컨텍스트에서 읽은 값을
// 넘긴다(서버=env 직접, client=useDashboardContext().navV3Flags). 생략 시 기존 기본값
// (false→/chats)과 바이트 동일 — 로그인 전 화면(login/register, DashboardContext 밖)은
// 아직 이 인자를 못 넘겨(플래그를 알 방법이 없음) 레거시 그대로(#4017 AC 스코프 밖,
// PO에 별도 보고 — 그라운딩 DM 참고).
function chatsFallback(chatV3Enabled: boolean): string {
  return chatV3Enabled ? '/chat' : '/chats';
}

/** 현재 경로(pathname+search)를 next 로 보존한 /login redirect 경로. */
export function buildLoginRedirect(currentPathAndSearch: string, chatV3Enabled = false): string {
  const fallback = chatsFallback(chatV3Enabled);
  const target = currentPathAndSearch && currentPathAndSearch.startsWith('/') ? currentPathAndSearch : fallback;
  return `/login?next=${encodeURIComponent(target)}&reason=${SESSION_EXPIRED_REASON}`;
}

/**
 * 오픈 리다이렉트 가드 — next 가 **내부 절대경로**(`/` 시작·`//`(프로토콜-상대)·`/\` 아님)일 때만 허용,
 * 아니면 `/chats`(story #3179 S3c AC2 — 로그인 랜딩=chat, 「홈=chat」 확定 반영). login 성공/콜백
 * 복귀 시 외부 도메인 유도(`//evil.com`·`http://`)를 차단.
 */
export function safeNextPath(next: string | null | undefined, chatV3Enabled = false): string {
  const fallback = chatsFallback(chatV3Enabled);
  if (!next) return fallback;
  let decoded: string;
  try { decoded = decodeURIComponent(next); } catch { return fallback; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) return fallback;
  return decoded;
}
