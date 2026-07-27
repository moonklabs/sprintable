/**
 * doc firebase-auth-login-ux-blueprint §2 S3 4번(TOTP 재등록 유도) 판정 — 이중 게이팅:
 * 클라 플래그(NEXT_PUBLIC_FIREBASE_AUTH_ENABLED)가 꺼져있거나, BE가 totp_enabled 필드를
 * 아직 반환하지 않으면(undefined) 절대 true를 반환하지 않는다. TOTP 미사용자에게 잘못
 * "2단계 인증 재등록" 메시지를 보여주지 않도록 엄격히 boolean true만 신뢰한다.
 */
export function shouldPromptTotpReenroll(flagEnabled: boolean, totpEnabled: boolean | undefined): boolean {
  return flagEnabled && totpEnabled === true;
}
