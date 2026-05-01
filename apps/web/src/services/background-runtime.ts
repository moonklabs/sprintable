import { createSupabaseAdminClient } from '@/lib/supabase/admin';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { DiscordGatewayRuntime } from './discord-gateway-runtime';
import { DiscordOutboundDispatcher } from './discord-outbound-dispatcher';
import { MemoEventDispatcher } from './memo-event-dispatcher';
import { SlackOutboundDispatcher } from './slack-outbound-dispatcher';
import { TeamsOutboundDispatcher } from './teams-outbound-dispatcher';
import { resolveAppUrl } from './app-url';

export type BackgroundRuntimeRole = 'web' | 'worker' | 'all';

export interface BackgroundRuntimeSettings {
  role: BackgroundRuntimeRole;
  basePollingIntervalMs: number;
  memoPollingIntervalMs: number;
  discordOutboundPollingIntervalMs: number;
  teamsOutboundPollingIntervalMs: number;
}

export interface BackgroundRuntimeWorkerOptions {
  supabase: SupabaseClient;
  appUrl?: string;
  settings?: BackgroundRuntimeSettings;
  createSlackOutboundDispatcher?: (input: { supabase: SupabaseClient; appUrl?: string }) => SlackOutboundDispatcherLike;
  createDiscordOutboundDispatcher?: (input: {
    supabase: SupabaseClient;
    appUrl?: string;
    pollingIntervalMs: number;
  }) => DiscordOutboundDispatcherLike;
  createDiscordGatewayRuntime?: (input: { supabase: SupabaseClient }) => DiscordGatewayRuntimeLike;
  createTeamsOutboundDispatcher?: (input: {
    supabase: SupabaseClient;
    appUrl?: string;
    pollingIntervalMs: number;
  }) => TeamsOutboundDispatcherLike;
  createMemoEventDispatcher?: (input: {
    supabase: SupabaseClient;
    pollingIntervalMs: number;
  }) => MemoEventDispatcherLike;
}

type SlackOutboundDispatcherLike = {
  start(): void;
  stop(): Promise<void>;
};

type DiscordOutboundDispatcherLike = {
  start(): void;
  stop(): Promise<void>;
};

type DiscordGatewayRuntimeLike = {
  start(): void;
  stop(): void;
};

type TeamsOutboundDispatcherLike = {
  start(): void;
  stop(): Promise<void>;
};

type MemoEventDispatcherLike = {
  start(): void;
  stop(): Promise<void>;
};

export const DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS = 60_000;
export const DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS = 15_000;

const VALID_RUNTIME_ROLES = new Set<BackgroundRuntimeRole>(['web', 'worker', 'all']);

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

export function resolveBackgroundRuntimeRole(env: NodeJS.ProcessEnv = process.env): BackgroundRuntimeRole {
  const rawRole = env['SPRINTABLE_RUNTIME_ROLE']?.trim().toLowerCase();
  if (rawRole && VALID_RUNTIME_ROLES.has(rawRole as BackgroundRuntimeRole)) {
    return rawRole as BackgroundRuntimeRole;
  }

  return env['NODE_ENV'] === 'production' ? 'web' : 'all';
}

export function shouldStartBackgroundRuntime(env: NodeJS.ProcessEnv = process.env) {
  const role = resolveBackgroundRuntimeRole(env);
  return role === 'worker' || role === 'all';
}

export function resolveBackgroundRuntimeSettings(env: NodeJS.ProcessEnv = process.env): BackgroundRuntimeSettings {
  const defaultBasePollingIntervalMs = env['NODE_ENV'] === 'production'
    ? DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS
    : DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS;

  const basePollingIntervalMs = parsePositiveInteger(env['SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS'], defaultBasePollingIntervalMs);

  return {
    role: resolveBackgroundRuntimeRole(env),
    basePollingIntervalMs,
    memoPollingIntervalMs: parsePositiveInteger(env['SPRINTABLE_MEMO_DISPATCHER_POLL_INTERVAL_MS'], basePollingIntervalMs),
    discordOutboundPollingIntervalMs: parsePositiveInteger(
      env['SPRINTABLE_DISCORD_OUTBOUND_POLL_INTERVAL_MS'],
      basePollingIntervalMs,
    ),
    teamsOutboundPollingIntervalMs: parsePositiveInteger(
      env['SPRINTABLE_TEAMS_OUTBOUND_POLL_INTERVAL_MS'],
      basePollingIntervalMs,
    ),
  };
}

export class BackgroundRuntimeWorker {
  private readonly slackOutboundDispatcher: SlackOutboundDispatcherLike;
  private readonly discordOutboundDispatcher: DiscordOutboundDispatcherLike;
  private readonly discordGatewayRuntime: DiscordGatewayRuntimeLike;
  private readonly teamsOutboundDispatcher: TeamsOutboundDispatcherLike;
  private readonly memoEventDispatcher: MemoEventDispatcherLike;
  private started = false;

  constructor(private readonly options: BackgroundRuntimeWorkerOptions) {
    const settings = options.settings ?? resolveBackgroundRuntimeSettings();

    this.slackOutboundDispatcher = options.createSlackOutboundDispatcher?.({
      supabase: options.supabase,
      appUrl: options.appUrl,
    }) ?? new SlackOutboundDispatcher({
      supabase: options.supabase,
      appUrl: options.appUrl,
    });

    this.discordOutboundDispatcher = options.createDiscordOutboundDispatcher?.({
      supabase: options.supabase,
      appUrl: options.appUrl,
      pollingIntervalMs: settings.discordOutboundPollingIntervalMs,
    }) ?? new DiscordOutboundDispatcher({
      supabase: options.supabase,
      appUrl: options.appUrl,
      pollingIntervalMs: settings.discordOutboundPollingIntervalMs,
    });

    this.discordGatewayRuntime = options.createDiscordGatewayRuntime?.({
      supabase: options.supabase,
    }) ?? new DiscordGatewayRuntime({
      supabase: options.supabase,
    });

    this.teamsOutboundDispatcher = options.createTeamsOutboundDispatcher?.({
      supabase: options.supabase,
      appUrl: options.appUrl,
      pollingIntervalMs: settings.teamsOutboundPollingIntervalMs,
    }) ?? new TeamsOutboundDispatcher({
      supabase: options.supabase,
      appUrl: options.appUrl,
      pollingIntervalMs: settings.teamsOutboundPollingIntervalMs,
    });

    this.memoEventDispatcher = options.createMemoEventDispatcher?.({
      supabase: options.supabase,
      pollingIntervalMs: settings.memoPollingIntervalMs,
    }) ?? new MemoEventDispatcher({
      supabase: options.supabase,
      pollingIntervalMs: settings.memoPollingIntervalMs,
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.slackOutboundDispatcher.start();
    this.discordOutboundDispatcher.start();
    this.discordGatewayRuntime.start();
    this.teamsOutboundDispatcher.start();
    this.memoEventDispatcher.start();
  }

  async stop() {
    if (!this.started) return;
    this.started = false;

    await Promise.allSettled([
      this.slackOutboundDispatcher.stop(),
      this.discordOutboundDispatcher.stop(),
      Promise.resolve(this.discordGatewayRuntime.stop()),
      this.teamsOutboundDispatcher.stop(),
      this.memoEventDispatcher.stop(),
    ]);
  }
}

export function createBackgroundRuntimeWorkerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return new BackgroundRuntimeWorker({
    supabase: createSupabaseAdminClient(),
    appUrl: resolveAppUrl(env['NEXT_PUBLIC_APP_URL'], env),
    settings: resolveBackgroundRuntimeSettings(env),
  });
}
