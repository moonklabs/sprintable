/**
 * 슬래시 커맨드 분류 — FE 미러 util (E-CHAT-CMD S8).
 *
 * 권위(SSOT) = 백엔드 `backend/app/services/command_classifier.py`(server-only).
 * 입력 중 즉시 분류(command 버블·escape preview)가 필요해 BE 규칙을 FE에 경량 미러한다.
 * BE 규칙 변경 시 이 util + parity 테스트(`command-classifier.test.ts`)를 동기화한다.
 * (`runtime-capabilities.ts`↔`agent_runtime.py`와 동일한 미러+parity 패턴 — drift 가드.)
 *
 * BE 실측 규칙:
 * - 커맨드 = `^/[a-zA-Z]` (맨 앞 `/` + ASCII 영문자). 선행 공백 ` /cmd`는 미일치(= 일반 text).
 * - `//cmd`는 커맨드 아님(`/` 다음이 `/`) — 리터럴. 렌더 시 `//`→`/` 1개 제거(dequote).
 * - name = 슬래시 뒤 첫 공백 전 토큰.
 */

// BE `_COMMAND_RE = re.compile(r"^/[a-zA-Z]\S*")` 의 진입 게이트.
const COMMAND_RE = /^\/[a-zA-Z]/;

/** 맨 앞이 `/` + ASCII 영문자면 커맨드 candidate. 선행 공백·`//`·비영문자는 false. */
export function isCommand(text: string | null | undefined): boolean {
  return !!text && COMMAND_RE.test(text);
}

/** 이스케이프 리터럴 렌더: 선행 `//` → `/` 1개 제거(`//review`→`/review`). 그 외 무변경. */
export function dequoteLiteral(text: string): string {
  return text.startsWith('//') ? text.slice(1) : text;
}

/** 커맨드 이름(슬래시 뒤 첫 공백 전 토큰, `/` 제외). 커맨드 아니면 null. */
export function commandName(text: string | null | undefined): string | null {
  if (!text || !COMMAND_RE.test(text)) return null;
  const firstToken = text.trim().split(/\s+/)[0] ?? '';
  return firstToken.slice(1);
}
