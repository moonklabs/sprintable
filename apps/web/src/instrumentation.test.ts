import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  shouldStartBackgroundRuntimeMock,
  createBackgroundRuntimeWorkerFromEnvMock,
  startMock,
} = vi.hoisted(() => ({
  shouldStartBackgroundRuntimeMock: vi.fn(),
  createBackgroundRuntimeWorkerFromEnvMock: vi.fn(),
  startMock: vi.fn(),
}));

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

  it('skips initialization when env is incomplete', async () => {
    createBackgroundRuntimeWorkerFromEnvMock.mockReturnValue(null);

    await register();

    expect(startMock).not.toHaveBeenCalled();
    expect(globalThis.__backgroundRuntimeWorker).toBeUndefined();
  });
});
