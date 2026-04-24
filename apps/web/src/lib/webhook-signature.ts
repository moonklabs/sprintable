import { createHmac } from 'crypto';

/**
 * HMAC-SHA256 웹훅 서명 생성 (AC1~AC4)
 *
 * 서명 대상: `${timestamp}.${body}`
 * 헤더: X-Webhook-Signature: sha256={hex}, X-Webhook-Timestamp: {ts}
 *
 * AC5: secret이 없으면 undefined 반환 → 헤더 미포함 (하위호환)
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
    'X-Webhook-Signature': `sha256=${signature}`,
    'X-Webhook-Timestamp': timestamp,
  };
}
