import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();
  const authCookies = allCookies.filter(c => c.name.includes('auth-token'));

  let userId: string | null = null;
  let authError: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    userId = data.user?.id?.slice(0, 8) ?? null;
    if (error) authError = error.message;
  } catch (e) {
    authError = String(e);
  }

  return Response.json({
    totalCookies: allCookies.length,
    authCookieCount: authCookies.length,
    authCookieNames: authCookies.map(c => c.name),
    authCookieDomains: authCookies.map(c => ({ name: c.name, valueLength: c.value.length })),
    userId,
    authError,
    userAgent: request.headers.get('user-agent')?.slice(0, 80),
    timestamp: new Date().toISOString(),
  });
}
