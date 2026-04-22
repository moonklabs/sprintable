import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createSupabaseServerClient() {
  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://localhost:54321';
  const supabaseAnonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? 'placeholder';
  const cookieStore = await cookies();

  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options: Record<string, unknown> }>) {
          try {
            const cookieDomain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, {
                ...(options as Parameters<typeof cookieStore.set>[2]),
                ...(cookieDomain ? { domain: cookieDomain } : {}),
              });
            }
          } catch {
            // Server Component에서는 set 불가 — 무시
          }
        },
      },
    },
  );
}
