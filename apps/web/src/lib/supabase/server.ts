// ssr import 제거됨 (C-S10)
// SaaS overlay에서 실제 구현 제공

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

export interface ServerSession {
  user_id: string;
  email: string;
  access_token: string;
}

export async function getServerSession(): Promise<ServerSession | null> {
  // SaaS overlay에서 이 파일을 오버라이드하여 실제 세션 반환
  // OSS 모드에서는 프록시가 인증을 처리하므로 null 반환 (호출되지 않음)
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createSupabaseServerClient(): Promise<any> {
  if (process.env['OSS_MODE'] === 'true') {
    return undefined;
  }
  // SaaS: overlay에서 이 파일을 오버라이드하여 실제 Supabase client 반환
  return undefined;
}
