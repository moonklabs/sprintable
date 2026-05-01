// SaaS 전용 admin client — @supabase/supabase-js를 dynamic import로 로드
export async function createSupabaseAdminClient() {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceRoleKey = process.env['SUPABASE_REPLICA_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('supabase_admin_client_env_missing');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
