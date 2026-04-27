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

  return globalThis.fetch(input, init).then(async (response) => {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retrySeconds = parseInt(retryAfterHeader ?? '', 10);
      const backoffSec = !isNaN(retrySeconds) ? Math.max(retrySeconds, 60) : 60;
      rateLimitBlockedUntil.set(url, Date.now() + backoffSec * 1000);
    }

    // refresh_token_already_used (HTTP 400) — SDK 재시도 루프 차단
    // 같은 URL로의 10분 backoff를 설정해 자동 refresh 루프를 중단시킴.
    if (response.status === 400 && url.includes('/token')) {
      try {
        const body = await response.clone().json() as Record<string, string>;
        const msg = (body.error_description ?? body.message ?? '').toLowerCase();
        const code = body.error ?? body.code ?? '';
        if (msg.includes('already used') || code === 'invalid_grant' || code === 'refresh_token_already_used') {
          rateLimitBlockedUntil.set(url, Date.now() + 600_000);
        }
      } catch { /* body parse 실패 무시 */ }
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
