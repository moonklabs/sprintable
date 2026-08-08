/**
 * story #2484 — 초대 수락/미리보기 실패의 error.code → i18n 문구 매핑을 한 곳에 둔다.
 * invite/page.tsx(미리보기+수락)·invite-accept-client.tsx(수락) 세 자리가 같은 백엔드
 * (backend/app/routers/invite_accept.py, plain-string HTTPException → 제네릭 코드로
 * 매핑됨)를 보므로, 여기서 한 번만 갈라 2벌 번역 갈림을 막는다.
 */
import type { useTranslations } from 'next-intl';

/** invite_accept.py가 실제로 낼 수 있는 코드 — 전부 plain-string detail이라 http_exception_handler가
 * HTTP 상태로 제네릭 매핑한다(404→NOT_FOUND·409→CONFLICT·410→HTTP_410·403→FORBIDDEN·400→BAD_REQUEST). */
export class InviteError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super(code ?? 'INVITE_ERROR');
    this.code = code;
  }
}

export function inviteErrorMessage(
  t: ReturnType<typeof useTranslations>,
  code: string | undefined,
  fallbackKey: string,
): string {
  switch (code) {
    case 'NOT_FOUND':
      return t('inviteNotFound');
    case 'CONFLICT':
      return t('inviteAlreadyAccepted');
    case 'HTTP_410':
      return t('inviteExpired');
    case 'FORBIDDEN':
      return t('inviteEmailMismatch');
    case 'BAD_REQUEST':
      return t('inviteCannotAccept');
    default:
      return t(fallbackKey);
  }
}
