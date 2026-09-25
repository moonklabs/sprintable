import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  shouldStartBackgroundRuntimeMock,
  createBackgroundRuntimeWorkerFromEnvMock,
  startMock,
  installBffDispatcherMock,
} = vi.hoisted(() => ({
  shouldStartBackgroundRuntimeMock: vi.fn(),
  createBackgroundRuntimeWorkerFromEnvMock: vi.fn(),
  startMock: vi.fn(),
  installBffDispatcherMock: vi.fn(),
}));

vi.mock('@/lib/server-dispatcher', () => ({ installBffDispatcher: installBffDispatcherMock }));

vi.mock('@/services/background-runtime', () => ({
  BackgroundRuntimeWorker: class {},
  shouldStartBackgroundRuntime: shouldStartBackgroundRuntimeMock,
  createBackgroundRuntimeWorkerFromEnv: createBackgroundRuntimeWorkerFromEnvMock,
}));

import { register } from './instrumentation';

describe('instrumentation.register', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    Object.assign(process.env, {
      NEXT_RUNTIME: 'nodejs',
      NODE_ENV: 'development',
    });
    shouldStartBackgroundRuntimeMock.mockReset();
    createBackgroundRuntimeWorkerFromEnvMock.mockReset();
    startMock.mockReset();
    installBffDispatcherMock.mockReset();
    shouldStartBackgroundRuntimeMock.mockReturnValue(true);
    createBackgroundRuntimeWorkerFromEnvMock.mockReturnValue({
      start: startMock,
    });
    delete globalThis.__backgroundRuntimeWorker;
  });

  afterEach(() => {
    delete process.env.NEXT_RUNTIME;
    Object.assign(process.env, {
      NODE_ENV: originalNodeEnv,
    });
    delete globalThis.__backgroundRuntimeWorker;
  });

  it('starts the background worker when runtime gating allows it', async () => {
    await register();

    expect(shouldStartBackgroundRuntimeMock).toHaveBeenCalledWith(process.env);
    expect(createBackgroundRuntimeWorkerFromEnvMock).toHaveBeenCalledWith(process.env);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(globalThis.__backgroundRuntimeWorker).toEqual({
      start: startMock,
    });
  });

  it('skips initialization when runtime gating disables background services', async () => {
    shouldStartBackgroundRuntimeMock.mockReturnValue(false);

    await register();

    expect(createBackgroundRuntimeWorkerFromEnvMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('skips initialization when the worker was already registered', async () => {
    globalThis.__backgroundRuntimeWorker = { start: vi.fn() } as never;

    await register();

    expect(createBackgroundRuntimeWorkerFromEnvMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  // story #4299 AC2 — BFF 서버 fetch 공유 연결 풀(전역 디스패처)은 nodejs 런타임 register에서 한 번, 백그라운드 워커 여부와 무관하게.
  it('installs the BFF connection pool in the nodejs runtime even when the worker is off or already registered', async () => {
    shouldStartBackgroundRuntimeMock.mockReturnValue(false);
    await register();
    globalThis.__backgroundRuntimeWorker = { start: vi.fn() } as never;
    await register();
    expect(installBffDispatcherMock).toHaveBeenCalledTimes(2); // 두 번 불려도 설치 함수가 idempotent(server-dispatcher.test.ts)
    expect(installBffDispatcherMock).toHaveBeenCalledWith();
  });

  it('does not install the connection pool outside the nodejs runtime or under test', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    Object.assign(process.env, { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'test' });
    await register();
    expect(installBffDispatcherMock).not.toHaveBeenCalled();
  });

  it('skips initialization when env is incomplete', async () => {
    createBackgroundRuntimeWorkerFromEnvMock.mockReturnValue(null);

    await register();

    expect(startMock).not.toHaveBeenCalled();
    expect(globalThis.__backgroundRuntimeWorker).toBeUndefined();
  });
});
