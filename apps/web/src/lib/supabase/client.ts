'use client';

// SaaS-only 브라우저 클라이언트 — OSS에서는 이 파일의 함수가 호출되지 않음
// @supabase/ssr은 dynamic import로 로드 (static import 제거, C-S10)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserClient = any;

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

    if (response.status === 400 && url.includes('/token')) {
      try {
        const body = await response.clone().json() as Record<string, string>;
        const msg = (body.error_description ?? body.message ?? '').toLowerCase();
        const code = body.error ?? body.code ?? '';
        if (msg.includes('already used') || msg.includes('already_used') || code === 'invalid_grant' || code === 'refresh_token_already_used') {
          const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
          document.cookie.split(';').forEach((c) => {
            const name = c.trim().split('=')[0];
            if (name?.startsWith('sb-')) {
              document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/${cookieDomain ? `; domain=${cookieDomain}` : ''}`;
            }
          });
          window.location.href = '/login';
        }
      } catch { /* body parse 실패 무시 */ }
    }

    return response;
  });
}

let _client: BrowserClient | null = null;

export function createSupabaseBrowserClient(): BrowserClient {
  if (_client) return _client;
  // @supabase/ssr를 즉시 require (브라우저 환경에서만 호출됨)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createBrowserClient } = require('@supabase/ssr') as typeof import('@supabase/ssr');
  const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  _client = createBrowserClient(
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
  return _client;
}
