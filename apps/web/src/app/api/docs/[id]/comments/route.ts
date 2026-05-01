import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBody, createDocCommentSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { notifyDocCommentMentions } from '@/services/doc-comment-notifications';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
    return apiSuccess(await service.getComments(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const parsed = await parseBody(request, createDocCommentSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
    const comment = await service.addComment({ doc_id: id, content: body.content, created_by: me.id });

    try {
      await notifyDocCommentMentions({
        sourceSupabase: supabase,
        adminSupabase: createSupabaseAdminClient(),
        docId: id,
        commentId: comment.id as string,
        content: comment.content as string,
        authorId: me.id,
      });
    } catch (notifyError) {
      console.error('[Docs] failed to create comment mention notifications', notifyError);
    }

    return apiSuccess(comment, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
