
import { buildWebhookSignatureHeaders } from '@/lib/webhook-signature';

interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
}

/**
 * 조직의 활성 웹훅에 이벤트 전송
 * - 해당 이벤트를 구독하는 웹훅만 발송
 */
export async function fireWebhooks(
  db: any,
  orgId: string,
  payload: WebhookPayload,
): Promise<void> {
  const { data: configs } = await db
    .from('webhook_configs')
    .select('url, secret, events')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (!configs?.length) return;

  const matching = configs.filter(
    (c) => c.events.length === 0 || c.events.includes(payload.event),
  );

  await Promise.allSettled(
    matching.map(async (config) => {
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildWebhookSignatureHeaders(config.secret, body),
      };

      await fetch(config.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
    }),
  );
}
