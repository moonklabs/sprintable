import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InboxOutboxService } from './inbox-outbox.service';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: 'org-1',
    inbox_item_id: 'item-1',
    event_type: 'resolved',
    payload: { hello: 'world' },
    webhook_url: 'https://agent.example.com/hook',
    status: 'in_flight',
    attempt_count: 1,
    ...overrides,
  };
}

describe('InboxOutboxService.scan', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns zero counts when no rows are claimed', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 });
    expect(supabase.rpc).toHaveBeenCalledWith('claim_pending_outbox', expect.any(Object));
  });

  it('delivers rows with 2xx response and marks delivered', async () => {
    const row = makeRow();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        if (name === 'mark_outbox_delivered') return { data: { ...row, status: 'delivered' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 1, delivered: 1, retried: 0, dead: 0, skipped: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-sprintable-org-id']).toBe('org-1');
    expect(headers['x-sprintable-event-type']).toBe('resolved');
    expect(headers['x-sprintable-outbox-id']).toBe(row.id);
    expect(headers['x-sprintable-signature']).toMatch(/^[0-9a-f]{64}$/);

    expect(rpcCalls.map(c => c.name)).toEqual(['claim_pending_outbox', 'mark_outbox_delivered']);
  });

  it('retries on 5xx response (status returned by mark_outbox_failed remains pending)', async () => {
    const row = makeRow({ attempt_count: 1 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        if (name === 'mark_outbox_failed') return { data: { ...row, status: 'pending' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 1, delivered: 0, retried: 1, dead: 0, skipped: 0 });
    expect(supabase.rpc).toHaveBeenCalledWith(
      'mark_outbox_failed',
      expect.objectContaining({ p_id: row.id, p_error: 'http_502' }),
    );
  });

  it('marks dead when mark_outbox_failed returns status=dead', async () => {
    const row = makeRow({ attempt_count: 5 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        if (name === 'mark_outbox_failed') return { data: { ...row, status: 'dead' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 1, delivered: 0, retried: 0, dead: 1, skipped: 0 });
  });

  it('skips and marks dead when webhook_url is null', async () => {
    const row = makeRow({ webhook_url: null });
    const fetchImpl = vi.fn();

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        if (name === 'mark_outbox_dead') return { data: { ...row, status: 'dead' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 1, delivered: 0, retried: 0, dead: 0, skipped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'mark_outbox_dead',
      expect.objectContaining({ p_error: 'no_webhook_url' }),
    );
  });

  it('treats fetch rejection as retryable failure', async () => {
    const row = makeRow();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        if (name === 'mark_outbox_failed') return { data: { ...row, status: 'pending' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 1, delivered: 0, retried: 1, dead: 0, skipped: 0 });
    expect(supabase.rpc).toHaveBeenCalledWith(
      'mark_outbox_failed',
      expect.objectContaining({ p_error: 'network down' }),
    );
  });

  it('processes multiple rows independently', async () => {
    const ok = makeRow({
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      webhook_url: 'https://ok.example.com/hook',
    });
    const fail = makeRow({
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      webhook_url: 'https://fail.example.com/hook',
    });
    const skip = makeRow({
      id: 'cccccccc-3333-4333-8333-333333333333',
      webhook_url: null,
    });

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === ok.webhook_url) return new Response(null, { status: 204 });
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [ok, fail, skip], error: null };
        if (name === 'mark_outbox_delivered') return { data: { ...ok, status: 'delivered' }, error: null };
        if (name === 'mark_outbox_failed') return { data: { ...fail, status: 'pending' }, error: null };
        if (name === 'mark_outbox_dead') return { data: { ...skip, status: 'dead' }, error: null };
        return { data: null, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      fetchImpl: fetchImpl as any,
      logger: { error: () => {} },
    });

    const result = await service.scan();

    expect(result).toEqual({ scanned: 3, delivered: 1, retried: 1, dead: 0, skipped: 1 });
  });

  it('throws when claim_pending_outbox RPC errors', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'pg_down' } }),
    };
    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: 'secret',
      logger: { error: () => {} },
    });

    await expect(service.scan()).rejects.toBeDefined();
  });

  it('omits HMAC header when no secret is configured', async () => {
    const row = makeRow();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const supabase = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'claim_pending_outbox') return { data: [row], error: null };
        return { data: { ...row, status: 'delivered' }, error: null };
      }),
    };

    const service = new InboxOutboxService(supabase as never, {
      hmacSecret: '',
      fetchImpl,
      logger: { error: () => {} },
    });

    await service.scan();

    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-sprintable-signature']).toBeUndefined();
  });
});
