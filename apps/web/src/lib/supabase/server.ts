// ssr import 제거됨 (C-S10)
// SaaS overlay에서 실제 구현 제공

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createSupabaseServerClient(): Promise<any> {
  if (process.env['OSS_MODE'] === 'true') {
    return undefined;
  }
  // SaaS: overlay에서 이 파일을 오버라이드하여 실제 Supabase client 반환
  return undefined;
}
