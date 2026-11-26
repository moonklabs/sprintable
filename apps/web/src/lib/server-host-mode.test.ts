// story 5024 (F1) — `serverHostMode`: a server host is known by its own backend's answer («an owner, and sign-up is closed»), not only by a public address.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_HOST_ASK_MS, SERVER_SETUP_STATE_PATH, serverHostMode } from './server-host-mode';

const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));
const EMBEDDED = { SPRINTABLE_EMBEDDED: '1' } as unknown as NodeJS.ProcessEnv;
const withOrigin = (o: string) => ({ ...EMBEDDED, SPRINTABLE_PUBLIC_ORIGIN: o }) as unknown as NodeJS.ProcessEnv;

// the backend's address is read from the process environment (lib/fastapi-url.ts — the one place that reads it)
let savedApi: string | undefined;
beforeEach(() => { savedApi = process.env['SPRINTABLE_API_ORIGIN']; process.env['SPRINTABLE_API_ORIGIN'] = 'http://127.0.0.1:43111'; });
afterEach(() => { if (savedApi === undefined) delete process.env['SPRINTABLE_API_ORIGIN']; else process.env['SPRINTABLE_API_ORIGIN'] = savedApi; });

describe('[SID:5024 F1] serverHostMode', () => {
  it('an owner and closed sign-up, no public address yet → a server host WITHOUT an address (the first owner has just signed up)', async () => {
    const ask = answer({ owner_exists: true, signup_open: false });
    expect(await serverHostMode(EMBEDDED, ask as never)).toEqual({ host: true, origin: null });
    // the question goes to the backend's own loopback address, uncached, with a time limit
    expect(ask).toHaveBeenCalledTimes(1);
    const [url, init] = ask.mock.calls[0] as unknown as [string, { cache: string; signal: AbortSignal }];
    expect(url).toBe(`http://127.0.0.1:43111${SERVER_SETUP_STATE_PATH}`);
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SERVER_HOST_ASK_MS).toBeLessThanOrEqual(2000);
  });

  it('a usable public address already says it — with that address, and no question asked', async () => {
    const ask = answer({ owner_exists: true, signup_open: false });
    expect(await serverHostMode(withOrigin('https://team.example.com'), ask as never)).toEqual({ host: true, origin: 'https://team.example.com' });
    expect(await serverHostMode(withOrigin('https://team.example.com:8443'), ask as never)).toEqual({ host: true, origin: 'https://team.example.com:8443' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('only a clear yes counts: sign-up open (the desktop app\'s server) · no owner yet · a refusal · a shape that is not understood · a network failure · a timeout → not a server host', async () => {
    for (const body of [
      { owner_exists: true, signup_open: true }, { owner_exists: false, signup_open: false }, { owner_exists: false, signup_open: true },
      { owner_exists: 'true', signup_open: false }, { owner_exists: true, signup_open: 'false' }, { owner_exists: true }, { signup_open: false }, {}, [], 'x', 1, null,
    ]) {
      expect(await serverHostMode(EMBEDDED, answer(body) as never), JSON.stringify(body)).toEqual({ host: false });
    }
    expect(await serverHostMode(EMBEDDED, answer({ owner_exists: true, signup_open: false }, false) as never)).toEqual({ host: false }); // 403 · 404 · 500
    expect(await serverHostMode(EMBEDDED, (async () => { throw new Error('ECONNREFUSED'); }) as never)).toEqual({ host: false });
    expect(await serverHostMode(EMBEDDED, (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as never)).toEqual({ host: false });
    expect(await serverHostMode(EMBEDDED, vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } })) as never)).toEqual({ host: false });
  });

  it('not an embedded server (a hosted deployment · the plain dev server): never a server host, and the question is never asked — a public address alone does not make one', async () => {
    const ask = answer({ owner_exists: true, signup_open: false });
    expect(await serverHostMode({} as NodeJS.ProcessEnv, ask as never)).toEqual({ host: false });
    expect(await serverHostMode({ SPRINTABLE_EMBEDDED: '0' } as unknown as NodeJS.ProcessEnv, ask as never)).toEqual({ host: false });
    expect(await serverHostMode({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' } as unknown as NodeJS.ProcessEnv, ask as never)).toEqual({ host: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it('an unusable public address is not an address: the backend is asked instead (and a server with an owner is then a host without an address)', async () => {
    const ask = answer({ owner_exists: true, signup_open: false });
    for (const bad of ['http://team.example.com', 'https://localhost', 'https://127.0.0.1', 'https://team.example.com/app', 'team.example.com', '']) {
      expect(await serverHostMode(withOrigin(bad), ask as never), bad).toEqual({ host: true, origin: null });
    }
    expect(ask).toHaveBeenCalledTimes(6);
  });
});
