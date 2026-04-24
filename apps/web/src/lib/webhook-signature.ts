import { createHmac } from 'crypto';

/**
 * HMAC-SHA256 웹훅 서명 생성
 *
 * 서명 대상: `${timestamp}.${body}`
 * 헤더: X-Sprintable-Signature: sha256={hex}, X-Sprintable-Timestamp: {ts}
 *
 * secret이 없으면 빈 객체 반환 → 헤더 미포함 (하위호환)
 *
 * --- 수신측 검증 예시 (Node.js) ---
 * const ts  = req.headers['x-sprintable-timestamp'];
 * const sig = req.headers['x-sprintable-signature']; // "sha256=<hex>"
 * const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
 * const ok = timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
 * if (!ok || Math.abs(Date.now() - Number(ts)) > 300_000) throw new Error('invalid signature');
 */
export function buildWebhookSignatureHeaders(
  secret: string | null | undefined,
  body: string,
): Record<string, string> {
  if (!secret) return {};
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    'X-Sprintable-Signature': `sha256=${signature}`,
    'X-Sprintable-Timestamp': timestamp,
  };
}
