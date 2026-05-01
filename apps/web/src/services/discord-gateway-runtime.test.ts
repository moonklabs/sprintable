import { describe, expect, it, vi } from 'vitest';
import { DiscordGatewayRuntime } from './discord-gateway-runtime';

function createDbStub(options?: {
  channels?: Array<Record<string, unknown>>;
  auth?: Record<string, unknown> | null;
  adminRecipients?: Array<Record<string, unknown>>;
}) {
  const state = {
    notifications: [] as Array<Record<string, unknown>>,
  };

  const channels = options?.channels ?? [{ org_id: 'org-1' }];
  const auth = options?.auth ?? { org_id: 'org-1', access_token_ref: 'env:DISCORD_RUNTIME_TOKEN', expires_at: null };
  const adminRecipients = options?.adminRecipients ?? [{ id: 'admin-1', user_id: 'user-1' }];

  const db = {
    from(table: string) {
      if (table === 'messaging_bridge_channels') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: channels, error: null }).then(resolve);
          },
        };
      }

      if (table === 'messaging_bridge_org_auths') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: auth, error: null }),
        };
      }

      if (table === 'org_members') {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: [{ user_id: 'user-1' }], error: null }).then(resolve);
          },
        };
      }

      if (table === 'team_members') {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: adminRecipients, error: null }).then(resolve);
          },
        };
      }

      if (table === 'notifications') {
        return {
          insert: async (payload: Record<string, unknown> | Record<string, unknown>[]) => {
            state.notifications.push(...(Array.isArray(payload) ? payload : [payload]));
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { db, state };
}

describe('DiscordGatewayRuntime', () => {
  it('starts one gateway bridge per active discord org with a valid token', async () => {
    process.env.DISCORD_RUNTIME_TOKEN = 'discord-runtime-token';
    const { db } = createDbStub();
    const start = vi.fn();
    const stop = vi.fn();
    const createBridge = vi.fn(() => ({ start, stop }));

    const runtime = new DiscordGatewayRuntime({
      db: db as never,
      createBridge,
      refreshIntervalMs: 60_000,
      logger: console,
    });

    await runtime.refresh();

    expect(createBridge).toHaveBeenCalledWith({ orgId: 'org-1', token: 'discord-runtime-token' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('records an auth_failed notification when the Discord token is missing or expired', async () => {
    const { db, state } = createDbStub({
      auth: { org_id: 'org-1', access_token_ref: 'env:DISCORD_RUNTIME_TOKEN', expires_at: '2026-04-07T00:00:00.000Z' },
    });
    delete process.env.DISCORD_RUNTIME_TOKEN;

    const runtime = new DiscordGatewayRuntime({
      db: db as never,
      refreshIntervalMs: 60_000,
      logger: console,
    });

    await runtime.refresh();

    expect(state.notifications[0]).toMatchObject({
      org_id: 'org-1',
      title: 'Discord bridge auth_failed',
    });
  });
});
