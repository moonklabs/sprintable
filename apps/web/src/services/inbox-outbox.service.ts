
import { createHmac } from 'crypto';
import type { SupabaseClient } from '@/types/supabase';

// Operator Cockpit Phase A — outbox worker
// Polls inbox_outbox via claim_pending_outbox RPC, POSTs to webhook_url with HMAC,
// then marks delivered / retries with exponential backoff / marks dead.
// Triggered from /api/cron/inbox-outbox by external scheduler.

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

type OutboxEventType = 'resolved' | 'dismissed' | 'reassigned';
type OutboxStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead';

interface OutboxRow {
  id: string;
  org_id: string;
  inbox_item_id: string;
  event_type: OutboxEventType;
  payload: Record<string, unknown>;
  webhook_url: string | null;
  status: OutboxStatus;
  attempt_count: number;
}

export interface OutboxScanResult {
  scanned: number;
  delivered: number;
  retried: number;
  dead: number;
  skipped: number;
}

export interface OutboxWorkerLogger {
  error: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
}

export interface InboxOutboxServiceOptions {
  logger?: OutboxWorkerLogger;
  hmacSecret?: string;
  batchSize?: number;
  deliveryTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class InboxOutboxService {
  private readonly logger: OutboxWorkerLogger;
  private readonly hmacSecret: string | undefined;
  private readonly batchSize: number;
  private readonly deliveryTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: SupabaseClient,
    options: InboxOutboxServiceOptions = {},
  ) {
    this.logger = options.logger ?? console;
    this.hmacSecret = options.hmacSecret ?? process.env['AGENT_INBOX_HMAC_SECRET'];
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async scan(): Promise<OutboxScanResult> {
    const result: OutboxScanResult = {
      scanned: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      skipped: 0,
    };

    const { data: rows, error } = await this.db.rpc('claim_pending_outbox', {
      p_batch_size: this.batchSize,
    });

    if (error) {
      this.logger.error('inbox_outbox_claim_failed', error);
      throw error;
    }

    const claimed = (rows ?? []) as OutboxRow[];
    result.scanned = claimed.length;
    if (claimed.length === 0) return result;

    for (const row of claimed) {
      if (!row.webhook_url) {
        await this.markDead(row.id, 'no_webhook_url');
        result.skipped++;
        continue;
      }

      try {
        await this.deliver(row);
        await this.markDelivered(row.id);
        result.delivered++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown_error';
        const becameDead = await this.markFailed(row.id, message);
        if (becameDead) result.dead++;
        else result.retried++;
      }
    }

    return result;
  }

  private async deliver(row: OutboxRow): Promise<void> {
    if (!row.webhook_url) throw new Error('no_webhook_url');

    const body = JSON.stringify(row.payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-sprintable-org-id': row.org_id,
      'x-sprintable-event-type': row.event_type,
      'x-sprintable-outbox-id': row.id,
    };
    if (this.hmacSecret) {
      headers['x-sprintable-signature'] = createHmac('sha256', this.hmacSecret)
        .update(body)
        .digest('hex');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(row.webhook_url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('delivery_timeout');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
  }

  private async markDelivered(id: string): Promise<void> {
    const { error } = await this.db.rpc('mark_outbox_delivered', { p_id: id });
    if (error) {
      this.logger.error('mark_outbox_delivered_failed', { id, error });
      throw error;
    }
  }

  /** Returns true if the row transitioned to 'dead'. */
  private async markFailed(id: string, errorMsg: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('mark_outbox_failed', {
      p_id: id,
      p_error: errorMsg,
    });
    if (error) {
      this.logger.error('mark_outbox_failed_failed', { id, error });
      throw error;
    }
    const status = (data as OutboxRow | null)?.status;
    return status === 'dead';
  }

  private async markDead(id: string, errorMsg: string): Promise<void> {
    const { error } = await this.db.rpc('mark_outbox_dead', {
      p_id: id,
      p_error: errorMsg,
    });
    if (error) {
      this.logger.error('mark_outbox_dead_failed', { id, error });
      throw error;
    }
  }
}
