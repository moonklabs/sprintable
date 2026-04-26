import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();
  const authCookies = allCookies.filter(c => c.name.includes('auth-token'));

  let userId: string | null = null;
  let authError: string | null = null;
  let sessionData = null;
  let sessionError: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.auth.getUser();
    userId = data.user?.id?.slice(0, 8) ?? null;
    if (error) authError = error.message;

    const { data: sd, error: se } = await supabase.auth.getSession();
    sessionData = sd.session ? {
      accessTokenExp: sd.session.expires_at,
      accessTokenPrefix: sd.session.access_token?.slice(0, 20),
      refreshTokenPrefix: sd.session.refresh_token?.slice(0, 10),
      expiresIn: sd.session.expires_in,
    } : null;
    if (se) sessionError = se.message;
  } catch (e) {
    authError = String(e);
  }

  return Response.json({
    totalCookies: allCookies.length,
    authCookieCount: authCookies.length,
    authCookieNames: authCookies.map(c => c.name),
    authCookieDomains: authCookies.map(c => ({ name: c.name, valueLength: c.value.length })),
    authCookieValuePrefixes: authCookies.map(c => ({ name: c.name, prefix: c.value.slice(0, 20) })),
    userId,
    authError,
    sessionData,
    sessionError,
    authPath: cookieStore.get('sp-auth-path')?.value ?? 'none',
    userAgent: request.headers.get('user-agent')?.slice(0, 80),
    timestamp: new Date().toISOString(),
  });
}
