import { createClient } from '@supabase/supabase-js';
import { apiSuccess, apiError } from '@/lib/api-response';

const CRON_SECRET = process.env.CRON_SECRET;

/** POST — 30일 경과 탈퇴 유저 PII 익명화 + auth 삭제 (cron에서 호출) */
export async function POST(request: Request) {
  // 크론 인증
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Invalid cron secret', 401);
  }

  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // DB 익명화 함수 호출 → 익명화된 user_id 목록 반환
  const { data: anonymized, error } = await supabaseAdmin
    .rpc('anonymize_deleted_users');

  if (error) {
    return apiError('ANONYMIZE_FAILED', error.message, 500);
  }

  // 각 user에 대해 auth.admin.deleteUser() 호출
  const deleted: string[] = [];
  for (const row of (anonymized ?? [])) {
    const userId = (row as { anonymized_user_id: string }).anonymized_user_id;
    try {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      deleted.push(userId);
    } catch {
      // 이미 삭제됐거나 실패 → 스킵 (다음 크론에서 재시도)
    }
  }

  return apiSuccess({ anonymized: anonymized?.length ?? 0, auth_deleted: deleted.length });
}
