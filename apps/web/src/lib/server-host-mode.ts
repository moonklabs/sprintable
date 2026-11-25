import { fastapiBaseUrl } from '@/lib/fastapi-url';
import { isEmbeddedServer, serverHostOrigin } from '@/lib/embedded-api-origin';

/**
 * story 5024 (AC4 · F1) — is this web process a workspace SERVER HOST's, and does it already have its public address?
 *
 * `isServerHost()` (lib/embedded-api-origin.ts) answers «an embedded server WITH a public address» — and a server's public address can only be set once it has an owner, so the screen
 * the first owner meets right after signing up (the onboarding's «에이전트» step) was still the Mac app's («에이전트는 내 Mac에서 돌아가요 · 지금은 받을 수 없어요»). The web has no environment name for «this is a
 * server host» (the host gives the web only `SPRINTABLE_PUBLIC_ORIGIN`, and only while the door is open), but its own backend knows: `GET /api/v2/server-setup/state` says `owner_exists` and `signup_open`,
 * and `signup_open` is false exactly when the first-owner rule (the server-host switch) is ON and an owner exists. That pair — «an owner, and sign-up is closed» — is a server host; the desktop
 * app's own server (rule OFF) always answers `signup_open: true`, a hosted deployment is not embedded and has no such route.
 *
 * The answer: not a server host (`{ host: false }` — everything stays as it was), or a server host with its address (`origin`, as `serverHostOrigin()` — the screens fill the pair command from it) or without
 * (`origin: null` — the screens say «set the public address first»). Anything that is not a clear yes — no answer, a slow one, a refusal, a shape that is not understood — is «not a server host»: the page never fails because of this question.
 * The question goes straight to the backend's loopback port from the server component (no browser, no forwarded header — the route refuses a caller that came through the relay).
 */
export type ServerHostMode = { host: false } | { host: true; origin: string | null };

export const SERVER_SETUP_STATE_PATH = '/api/v2/server-setup/state';
export const SERVER_HOST_ASK_MS = 1500;

type Ask = (url: string, init: { cache: 'no-store'; signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export async function serverHostMode(env: NodeJS.ProcessEnv = process.env, ask: Ask = fetch as unknown as Ask): Promise<ServerHostMode> {
  if (!isEmbeddedServer(env)) return { host: false };
  const origin = serverHostOrigin(env);
  if (origin !== null) return { host: true, origin }; // the address is set: that already says it (the supervisor sets it only while an owner exists and sign-up is closed)
  try {
    const res = await ask(new URL(SERVER_SETUP_STATE_PATH, fastapiBaseUrl()).toString(), { cache: 'no-store', signal: AbortSignal.timeout(SERVER_HOST_ASK_MS) });
    if (!res.ok) return { host: false };
    const body = (await res.json()) as { owner_exists?: unknown; signup_open?: unknown } | null;
    if (typeof body === 'object' && body !== null && body.owner_exists === true && body.signup_open === false) return { host: true, origin: null };
  } catch {
    // unreachable · timed out · not JSON: not a clear yes
  }
  return { host: false };
}
