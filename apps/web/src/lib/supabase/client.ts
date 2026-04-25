'use client';

import { createBrowserClient } from '@supabase/ssr';

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
    },
  );
}
