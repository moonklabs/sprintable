import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
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
    const db = { tag: 'db' } as never;
    const worker = new BackgroundRuntimeWorker({
      db,
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
      db,
      appUrl: 'https://app.example.com',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      db,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 120000,
    });
    expect(gatewayCtorMock).toHaveBeenCalledWith({
      db,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      db,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 180000,
    });
    expect(memoCtorMock).toHaveBeenCalledWith({
      db,
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

  // C-S11(e17719fc)에서 Supabase admin client(createAdminClient/lib/db/admin.ts)가
  // 전량 제거됐다. createBackgroundRuntimeWorkerFromEnv는 더 이상 db 클라이언트를
  // 만들지 않고 db: undefined로 dispatcher를 구성한다(영속은 FastAPI 경유). 아래는
  // 그 현 계약을 검증한다 — 옛 service-role 팩토리/널-가드는 폐기됐다.
  it('creates a worker from env with db-less dispatchers (post-Supabase)', () => {
    const worker = createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
      SPRINTABLE_BACKGROUND_POLL_INTERVAL_MS: '45000',
    } as NodeJS.ProcessEnv);

    expect(worker).toBeInstanceOf(BackgroundRuntimeWorker);
    expect(slackCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://app.example.com',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 45000,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://app.example.com',
      pollingIntervalMs: 45000,
    });
    expect(memoCtorMock).toHaveBeenCalledWith({
      db: undefined,
      pollingIntervalMs: 45000,
    });
  });

  it('falls back to the Vercel URL when NEXT_PUBLIC_APP_URL is missing', () => {
    createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'myapp.vercel.app',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
    } as NodeJS.ProcessEnv);

    expect(slackCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://myapp.vercel.app',
    });
    expect(discordCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://myapp.vercel.app',
      pollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
    expect(teamsCtorMock).toHaveBeenCalledWith({
      db: undefined,
      appUrl: 'https://myapp.vercel.app',
      pollingIntervalMs: DEFAULT_PRODUCTION_BACKGROUND_POLLING_INTERVAL_MS,
    });
  });

  it('still creates a worker without service-role db env (no admin client gate)', () => {
    const worker = createBackgroundRuntimeWorkerFromEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      SPRINTABLE_RUNTIME_ROLE: 'worker',
    } as NodeJS.ProcessEnv);

    // 옛 동작: service-role env 불완전 시 null. 현재: admin client가 없어 게이트도 없다.
    expect(worker).toBeInstanceOf(BackgroundRuntimeWorker);
  });
});
