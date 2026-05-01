import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

/** POST — 메모를 스토리로 전환 */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Memo conversion is not available in OSS mode.', 501);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const body = await request.json();
    const memoId = body.memo_id;
    if (!memoId) return ApiErrors.badRequest('memo_id required');

    // 메모 조회
    const { data: memo, error: memoErr } = await supabase
      .from('memos')
      .select('id, title, content')
      .eq('id', memoId)
      .single();

    if (memoErr || !memo) return ApiErrors.notFound('Memo not found');

    // 클라이언트에서 프리필된 title/description 사용 (없으면 메모 기본값)
    const storyTitle = body.title || memo.title || memo.content?.slice(0, 100) || 'Untitled';
    const memoDeeplink = `/memos?id=${memo.id}`;
    const storyDesc = `${body.description || memo.content}\n\n---\n[📎 Original memo #${memo.id}](${memoDeeplink})`;

    const { data: story, error: storyErr } = await supabase
      .from('stories')
      .insert({
        org_id: me.org_id,
        project_id: me.project_id,
        title: storyTitle,
        description: storyDesc,
        status: 'backlog',
        priority: 'medium',
      })
      .select('id, title')
      .single();

    if (storyErr || !story) {
      return apiError('CONVERSION_FAILED', storyErr?.message ?? 'Failed to create story', 500);
    }

    // 메모에 "Converted to SID:xxx" 답글 추가
    await supabase
      .from('memo_replies')
      .insert({
        memo_id: memoId,
        content: `✅ Converted to story SID:${story.id}`,
        created_by: me.id,
        review_type: 'comment',
      });

    return apiSuccess({ story_id: story.id, story_title: story.title }, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
