import { createHmac, timingSafeEqual } from 'node:crypto';

// E-STORAGE-SSOT S1 (D2): local provider 의 capability-URL 서명.
//
// local disk 는 네이티브 서명이 없으므로, sign 라우트(`/api/attachments/sign`)의 기존 BE
// authorize 게이트를 통과한 뒤에만 이 HMAC 토큰을 발급한다 → serve 라우트는 토큰 검증만 한다
// (신규 authz surface 0·scope 우회 0). GCS V4 signed URL 과 동치(짧은 만료 capability URL).

function payload(container: string, objectPath: string, exp: number): string {
  return `${container}/${objectPath}:${exp}`;
}

/** authorize 통과 후 발급되는 단기 서명. */
export function signLocalObject(
  secret: string,
  container: string,
  objectPath: string,
  exp: number,
): string {
  return createHmac('sha256', secret).update(payload(container, objectPath, exp)).digest('hex');
}

/** serve 라우트의 토큰 검증(만료·서명 일치). 타이밍 세이프 비교. */
export function verifyLocalObject(
  secret: string,
  container: string,
  objectPath: string,
  exp: number,
  sig: string,
): boolean {
  if (!secret || !sig) return false;
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signLocalObject(secret, container, objectPath, exp);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
