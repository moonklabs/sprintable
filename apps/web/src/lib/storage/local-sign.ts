import { createHmac, timingSafeEqual } from 'node:crypto';

// E-STORAGE-SSOT S1 (D2): local provider 의 capability-URL 서명.
//
// local disk 는 네이티브 서명이 없으므로, sign 라우트(`/api/attachments/sign`)의 기존 BE
// authorize 게이트를 통과한 뒤에만 이 HMAC 토큰을 발급한다 → serve 라우트는 토큰 검증만 한다
// (신규 authz surface 0·scope 우회 0). GCS V4 signed URL 과 동치(짧은 만료 capability URL).

// story dc3d62f4(BE·스토리지·self-host, local PUT 부재 처방) — BE `local.py::signed_write_url`가
// write 서명 payload에 `PUT:` 접두어를 이미 묶고 있었다(read와 같은 시그니처를 write에 재사용하지
// 못하게). 그런데 이 FE 파일의 payload()는 method를 아예 몰라 GET/PUT을 구분 못 했다 — BE가
// 발급한 write 서명은 여기서 절대 검증을 통과할 수 없는 상태였다(payload 문자열 자체가
// 다르므로). method를 명시 인자로 받아 BE와 동일한 접두어 규칙을 따르게 한다.
function payload(container: string, objectPath: string, exp: number, method: 'GET' | 'PUT' = 'GET'): string {
  const base = `${container}/${objectPath}:${exp}`;
  return method === 'PUT' ? `PUT:${base}` : base;
}

/** authorize 통과 후 발급되는 단기 서명. method 기본값 GET(기존 read 호출부 무회귀). */
export function signLocalObject(
  secret: string,
  container: string,
  objectPath: string,
  exp: number,
  method: 'GET' | 'PUT' = 'GET',
): string {
  return createHmac('sha256', secret).update(payload(container, objectPath, exp, method)).digest('hex');
}

/** serve 라우트의 토큰 검증(만료·서명 일치). 타이밍 세이프 비교. method 기본값 GET —
 * write(PUT) 서명을 검증하려면 method='PUT'을 명시해야 한다(GET 서명으로 PUT 인가 금지). */
export function verifyLocalObject(
  secret: string,
  container: string,
  objectPath: string,
  exp: number,
  sig: string,
  method: 'GET' | 'PUT' = 'GET',
): boolean {
  if (!secret || !sig) return false;
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signLocalObject(secret, container, objectPath, exp, method);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
