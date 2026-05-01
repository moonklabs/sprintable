// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { DiscordGatewayBridge } from './discord-gateway-bridge';
import { getActiveDiscordOrgAuth, isDiscordAuthExpired, notifyDiscordAuthFailed, resolveDiscordToken } from './discord-bridge-utils';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

type BridgeLike = { start(): void; stop(): void };

export interface DiscordGatewayRuntimeOptions {
  supabase: SupabaseClient;
  logger?: Logger;
  refreshIntervalMs?: number;
  createBridge?: (input: { orgId: string; token: string }) => BridgeLike;
}

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export class DiscordGatewayRuntime {
  private readonly logger: Logger;
  private readonly refreshIntervalMs: number;
  private readonly createBridge: (input: { orgId: string; token: string }) => BridgeLike;
  private readonly bridges = new Map<string, BridgeLike>();
  private readonly authFailureReasons = new Map<string, string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DiscordGatewayRuntimeOptions) {
    this.logger = options.logger ?? console;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.createBridge = options.createBridge ?? ((input) => new DiscordGatewayBridge({
      supabase: this.options.supabase,
      orgId: input.orgId,
      token: input.token,
      logger: this.logger,
      onAuthFailed: async (orgId, reason) => {
        await this.reportAuthFailed(orgId, reason);
      },
    }));
  }

  start() {
    void this.refresh();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh();
      }, this.refreshIntervalMs);
    }
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const bridge of this.bridges.values()) {
      bridge.stop();
    }
    this.bridges.clear();
    this.authFailureReasons.clear();
  }

  async refresh() {
    const activeOrgIds = await this.listActiveDiscordOrgIds();
    const activeOrgIdSet = new Set(activeOrgIds);

    for (const orgId of [...this.bridges.keys()]) {
      if (!activeOrgIdSet.has(orgId)) {
        this.bridges.get(orgId)?.stop();
        this.bridges.delete(orgId);
        this.authFailureReasons.delete(orgId);
      }
    }

    for (const orgId of activeOrgIds) {
      const auth = await getActiveDiscordOrgAuth(this.options.supabase, orgId);
      const token = resolveDiscordToken(auth?.access_token_ref);
      if (!auth || !token || isDiscordAuthExpired(auth.expires_at)) {
        this.bridges.get(orgId)?.stop();
        this.bridges.delete(orgId);
        await this.reportAuthFailed(orgId, 'auth_failed');
        continue;
      }

      this.authFailureReasons.delete(orgId);
      if (this.bridges.has(orgId)) {
        continue;
      }

      const bridge = this.createBridge({ orgId, token });
      bridge.start();
      this.bridges.set(orgId, bridge);
      this.logger.info(`[DiscordGatewayRuntime] Bridge started for org ${orgId}`);
    }
  }

  private async listActiveDiscordOrgIds() {
    const { data, error } = await this.options.supabase
      .from('messaging_bridge_channels')
      .select('org_id')
      .eq('platform', 'discord')
      .eq('is_active', true);

    if (error) throw error;
    return [...new Set((data ?? []).map((row) => String((row as { org_id: string }).org_id)).filter(Boolean))] as string[];
  }

  private async reportAuthFailed(orgId: string, reason: string) {
    if (this.authFailureReasons.get(orgId) === reason) return;
    this.authFailureReasons.set(orgId, reason);
    await notifyDiscordAuthFailed(this.options.supabase, orgId, reason);
  }
}
