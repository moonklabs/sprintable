'use client';

import { createBrowserClient } from '@supabase/ssr';

// URL별 rate-limit backoff 만료 시각 (ms). 모듈 스코프로 탭 전체 공유.
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

  return globalThis.fetch(input, init).then((response) => {
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
      global: {
        fetch: rateLimitedFetch,
      },
    },
  );
}
