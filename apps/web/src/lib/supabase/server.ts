import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

export interface ServerSession {
  user_id: string;
  email: string;
  access_token: string;
}

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    if (payload['type'] !== 'access' || !payload.sub) return null;
    return { user_id: payload.sub, email: (payload['email'] as string) ?? '', access_token: token };
  } catch {
    return null;
  }
}

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
                secure: true,
              });
            }
          } catch {
            // Server Component에서는 set 불가 — middleware refreshing user sessions에서는 무시
          }
        },
      },
    },
  );
}
