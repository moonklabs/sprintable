import type { SupabaseClient } from '@supabase/supabase-js';

interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
}

/**
 * 조직의 활성 웹훅에 이벤트 전송
 * - 해당 이벤트를 구독하는 웹훅만 발송
 */
export async function fireWebhooks(
  supabase: SupabaseClient,
  orgId: string,
  payload: WebhookPayload,
): Promise<void> {
  const { data: configs } = await supabase
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.secret) headers['X-Webhook-Secret'] = config.secret;

      await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    }),
  );
}
