import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';

/** POST — 계정 탈퇴 요청 (30일 유예) */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const now = new Date().toISOString();

    // 재인증 검증: 최근 로그인 10분 이내인지 확인
    const lastSignIn = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : 0;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    if (lastSignIn < tenMinutesAgo) {
      return apiError('REAUTHENTICATION_REQUIRED', 'Please sign in again before deleting your account.', 403);
    }

    // org_members soft delete (deleted_at)
    await supabase
      .from('org_members')
      .update({ deleted_at: now })
      .eq('user_id', user.id);

    // team_members soft delete (deleted_at)
    await supabase
      .from('team_members')
      .update({ deleted_at: now, is_active: false, updated_at: now })
      .eq('user_id', user.id);

    // 탈퇴 요청 기록
    await supabase.auth.updateUser({
      data: { deletion_requested_at: now },
    });

    // 세션 종료
    await supabase.auth.signOut();

    return apiSuccess({ ok: true, grace_period_days: 30 });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
