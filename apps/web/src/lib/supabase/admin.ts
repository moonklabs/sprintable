// SaaS-only — OSS에서는 호출되지 않음. SaaS overlay에서 실제 구현 제공.
export async function createSupabaseAdminClient(): Promise<never> {
  throw new Error('createSupabaseAdminClient: SaaS overlay required');
}
