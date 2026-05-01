'use client';

import { createBrowserClient } from '@supabase/ssr';

// ─── FastAPI Auth Utilities ───────────────────────────────────────────────────

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface AuthResult {
  data: AuthTokens | null;
  error: { code: string; message: string } | null;
}

async function callAuthRoute(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { data?: AuthTokens | { ok: boolean }; error?: { code: string; message: string } };
  if (!res.ok) {
    return { data: null, error: json.error ?? { code: 'UNKNOWN', message: 'Unknown error' } };
  }
  return { data: json.data as AuthTokens, error: null };
}

export async function loginWithPassword(
  email: string,
  password: string,
  totpCode?: string,
): Promise<AuthResult> {
  return callAuthRoute('/api/auth/login', { email, password, totp_code: totpCode ?? null });
}

export async function registerUser(email: string, password: string): Promise<AuthResult> {
  return callAuthRoute('/api/auth/register', { email, password });
}

export async function logoutUser(refreshToken?: string): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken ?? '' }),
  });
}

export async function refreshAuthTokens(): Promise<AuthResult> {
  return callAuthRoute('/api/auth/refresh', {});
}

// ─── Supabase Browser Client (realtime / DB only — auth via FastAPI) ─────────

const rateLimitBlockedUntil = new Map<string, number>();

function getUrlKey(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function rateLimitedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = getUrlKey(input);
  const now = Date.now();
  const blockedUntil = rateLimitBlockedUntil.get(url);
  if (blockedUntil && now < blockedUntil) {
    const remainingSec = Math.ceil((blockedUntil - now) / 1000);
    return Promise.reject(new Error(`rate_limit_backoff:${remainingSec}`));
  }
  return globalThis.fetch(input, init).then(async (response) => {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retrySeconds = parseInt(retryAfterHeader ?? '', 10);
      const backoffSec = !isNaN(retrySeconds) ? Math.max(retrySeconds, 60) : 60;
      rateLimitBlockedUntil.set(url, Date.now() + backoffSec * 1000);
    }
    return response;
  });
}

export function createSupabaseBrowserClient() {
  const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return createBrowserClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookieOptions: {
        ...(cookieDomain ? { domain: cookieDomain } : {}),
        sameSite: 'lax',
        secure: true,
        path: '/',
      },
      global: { fetch: rateLimitedFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
