import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createClientMock,
  slackCtorMock,
  slackStartMock,
  slackStopMock,
  discordCtorMock,
  discordStartMock,
  discordStopMock,
  gatewayCtorMock,
  gatewayStartMock,
  gatewayStopMock,
  teamsCtorMock,
  teamsStartMock,
  teamsStopMock,
  memoCtorMock,
  memoStartMock,
  memoStopMock,
} = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  slackCtorMock: vi.fn(),
  slackStartMock: vi.fn(),
  slackStopMock: vi.fn().mockResolvedValue(undefined),
  discordCtorMock: vi.fn(),
  discordStartMock: vi.fn(),
  discordStopMock: vi.fn().mockResolvedValue(undefined),
  gatewayCtorMock: vi.fn(),
  gatewayStartMock: vi.fn(),
  gatewayStopMock: vi.fn(),
  teamsCtorMock: vi.fn(),
  teamsStartMock: vi.fn(),
  teamsStopMock: vi.fn().mockResolvedValue(undefined),
  memoCtorMock: vi.fn(),
  memoStartMock: vi.fn(),
  memoStopMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

vi.mock('./slack-outbound-dispatcher', () => ({
  SlackOutboundDispatcher: class {
    constructor(options: unknown) {
      slackCtorMock(options);
    }

    start() {
      slackStartMock();
    }

    stop() {
      return slackStopMock();
    }
  },
}));

vi.mock('./discord-outbound-dispatcher', () => ({
  DiscordOutboundDispatcher: class {
    constructor(options: unknown) {
      discordCtorMock(options);
    }

    start() {
      discordStartMock();
    }

    stop() {
      return discordStopMock();
    }
  },
}));

vi.mock('./discord-gateway-runtime', () => ({
  DiscordGatewayRuntime: class {
    constructor(options: unknown) {
      gatewayCtorMock(options);
    }

    start() {
      gatewayStartMock();
    }

    stop() {
      gatewayStopMock();
    }
  },
}));

vi.mock('./teams-outbound-dispatcher', () => ({
  TeamsOutboundDispatcher: class {
    constructor(options: unknown) {
      teamsCtorMock(options);
    }

    start() {
      teamsStartMock();
    }

    stop() {
      return teamsStopMock();
    }
  },
}));

vi.mock('./memo-event-dispatcher', () => ({
  MemoEventDispatcher: class {
    constructor(options: unknown) {
      memoCtorMock(options);
    }

    start() {
      memoStartMock();
    }

    stop() {
      return memoStopMock();
    }
  },
}));

import {
  BackgroundRuntimeWorker,
  createBackgroundRuntimeWorkerFromEnv,
  DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
  DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
  resolveBackgroundRuntimeRole,
  resolveBackgroundRuntimeSettings,
  shouldStartBackgroundRuntime,
} from './background-runtime';

describe('background-runtime settings', () => {
  it('defaults production env to web role with relaxed polling', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

    expect(resolveBackgroundRuntimeRole(env)).toBe('web');
    expect(shouldStartBackgroundRuntime(env)).toBe(false);
    expect(resolveBackgroundRuntimeSettings(env)).toEqual({
      role: 'web',
      basePollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      memoPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      discordOutboundPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      teamsOutboundPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
  });

  it('defaults non-production env to all role with current polling', () => {
    const env = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

    expect(resolveBackgroundRuntimeRole(env)).toBe('all');
    expect(shouldStartBackgroundRuntime(env)).toBe(true);
    expect(resolveBackgroundRuntimeSettings(env)).toEqual({
      role: 'all',
      basePollingIntervalMs: DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      memoPollingIntervalMs: DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      discordOutboundPollingIntervalMs: DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      teamsOutboundPollingIntervalMs: DEFAULT_NON_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
  });

  it('applies runtime role and polling overrides from env', () => {
    const env = {
      NODE_ENV: 'production',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
      SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS: '45000',
      SPRINTABLE_MEMO_DISPATCHER_POLL_INTERVAL_MS: '90000',
      SPRINTABLE_DISCORD_OUTBOUND_POLL_INTERVAL_MS: '120000',
      SPRINTABLE_TEAMS_OUTBOUND_POLL_INTERVAL_MS: '150000',
    } as NodeJS.ProcessEnv;

    expect(resolveBackgroundRuntimeRole(env)).toBe('worker');
    expect(resolveBackgroundRuntimeSettings(env)).toEqual({
      role: 'worker',
      basePollingIntervalMs: 45000,
      memoPollingIntervalMs: 90000,
      discordOutboundPollingIntervalMs: 120000,
      teamsOutboundPollingIntervalMs: 150000,
    });
    expect(shouldStartBackgroundRuntime(env)).toBe(true);
  });

  it('falls back on invalid runtime and interval values', () => {
    const env = {
      NODE_ENV: 'production',
      SPRINTABLE_RUNTIME_ROLE: 'sidecar',
      SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS: '0',
      SPRINTABLE_MEMO_DISPATCHER_POLL_INTERVAL_MS: '-10',
      SPRINTABLE_DISCORD_OUTBOUND_POLL_INTERVAL_MS: 'wat',
      SPRINTABLE_TEAMS_OUTBOUND_POLL_INTERVAL_MS: 'nan',
    } as NodeJS.ProcessEnv;

    expect(resolveBackgroundRuntimeRole(env)).toBe('web');
    expect(resolveBackgroundRuntimeSettings(env)).toEqual({
      role: 'web',
      basePollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      memoPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      discordOutboundPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
      teamsOutboundPollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
  });
});

describe('BackgroundRuntimeWorker', () => {
  beforeEach(() => {
    createClientMock.mockReset();
    slackCtorMock.mockReset();
    slackStartMock.mockReset();
    slackStopMock.mockClear();
    discordCtorMock.mockReset();
    discordStartMock.mockReset();
    discordStopMock.mockClear();
    gatewayCtorMock.mockReset();
    gatewayStartMock.mockReset();
    gatewayStopMock.mockReset();
    teamsCtorMock.mockReset();
    teamsStartMock.mockReset();
    teamsStopMock.mockClear();
    memoCtorMock.mockReset();
    memoStartMock.mockReset();
    memoStopMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts and stops the shared background services once', async () => {
    const supabase = { tag: 'supabase' } as never;
    const worker = new BackgroundRuntimeWorker({
      supabase,
      appUrl: 'https://app.example.com',
      settings: {
        role: 'worker',
        basePollingIntervalMs: 60000,
        memoPollingIntervalMs: 90000,
        discordOutboundPollingIntervalMs: 120000,
        teamsOutboundPollingIntervalMs: 180000,
      },
    });

    worker.start();
    worker.start();

    expect(slackCtorMock).toHaveBeenCalledWith({
      supabase,
      appUrl: 'https://app.example.com',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      supabase,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 120000,
    });
    expect(gatewayCtorMock).toHaveBeenCalledWith({
      supabase,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      supabase,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 180000,
    });
    expect(memoCtorMock).toHaveBeenCalledWith({
      supabase,
      pollingIntervalMs: 90000,
    });
    expect(slackStartMock).toHaveBeenCalledTimes(1);
    expect(discordStartMock).toHaveBeenCalledTimes(1);
    expect(gatewayStartMock).toHaveBeenCalledTimes(1);
    expect(teamsStartMock).toHaveBeenCalledTimes(1);
    expect(memoStartMock).toHaveBeenCalledTimes(1);

    await worker.stop();

    expect(slackStopMock).toHaveBeenCalledTimes(1);
    expect(discordStopMock).toHaveBeenCalledTimes(1);
    expect(gatewayStopMock).toHaveBeenCalledTimes(1);
    expect(teamsStopMock).toHaveBeenCalledTimes(1);
    expect(memoStopMock).toHaveBeenCalledTimes(1);
  });

  it('creates a worker from env using the shared service-role client', () => {
    createClientMock.mockReturnValue({ tag: 'supabase-client' });

    const worker = createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
      SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS: '45000',
    } as NodeJS.ProcessEnv);

    expect(createClientMock).toHaveBeenCalledWith('https://supabase.example.com', 'service-role-key');
    expect(worker).toBeInstanceOf(BackgroundRuntimeWorker);
    expect(slackCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://app.example.com',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 45000,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 45000,
    });
    expect(memoCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      pollingIntervalMs: 45000,
    });
  });

  it('falls back to the Vercel URL when APP_BASE_URL is missing', () => {
    createClientMock.mockReturnValue({ tag: 'supabase-client' });

    createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      VERCEL_PROJECT_PRODUCTION_URL: 'myapp.vercel.app',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
    } as NodeJS.ProcessEnv);

    expect(slackCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://myapp.vercel.app',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://myapp.vercel.app',
      pollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      supabase: { tag: 'supabase-client' },
      appUrl: 'https://myapp.vercel.app',
      pollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
  });

  it('returns null when service-role env is incomplete', () => {
    const worker = createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com',
    } as NodeJS.ProcessEnv);

    expect(worker).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
