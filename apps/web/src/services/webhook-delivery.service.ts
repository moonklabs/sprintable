
import type { SupabaseClient } from '@/types/supabase';

const BACKOFF_DELAYS_MS = [0, 1_000, 4_000] as const; // attempt 0,1,2 전 대기
const MAX_ATTEMPTS = 3;

export interface WebhookDispatchInput {
  org_id: string;
  webhook_config_id: string | null;
  event_type: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  fetchFn?: typeof fetch;
}

export class WebhookDeliveryService {
  constructor(private readonly db: SupabaseClient) {}

  async dispatch(input: WebhookDispatchInput): Promise<boolean> {
    const { org_id, webhook_config_id, event_type, url, headers, body } = input;
    const fetchFn = input.fetchFn ?? fetch;

    const { data: delivery, error: insertError } = await this.db
      .from('webhook_deliveries')
      .insert({ org_id, webhook_config_id, event_type, payload: { url, body } })
      .select('id')
      .single();

    if (insertError || !delivery) {
      // delivery 기록 실패해도 발송은 시도
      return this._sendWithRetry(fetchFn, url, headers, body, null, null);
    }

    return this._sendWithRetry(fetchFn, url, headers, body, delivery.id as string, org_id);
  }

  private async _sendWithRetry(
    fetchFn: typeof fetch,
    url: string,
    headers: Record<string, string>,
    body: string,
    deliveryId: string | null,
    orgId: string | null,
  ): Promise<boolean> {
    let lastError = '';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_DELAYS_MS[attempt] > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_DELAYS_MS[attempt]));
      }

      if (deliveryId) {
        await this.db
          .from('webhook_deliveries')
          .update({ attempts: attempt + 1 })
          .eq('id', deliveryId);
      }

      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          if (deliveryId) {
            await this.db
              .from('webhook_deliveries')
              .update({ status: 'success', delivered_at: new Date().toISOString() })
              .eq('id', deliveryId);
          }
          return true;
        }

        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (deliveryId) {
        await this.db
          .from('webhook_deliveries')
          .update({ last_error: lastError })
          .eq('id', deliveryId);
      }
    }

    if (deliveryId) {
      await this.db
        .from('webhook_deliveries')
        .update({ status: 'failed', last_error: lastError })
        .eq('id', deliveryId);
    }

    return false;
  }
}
