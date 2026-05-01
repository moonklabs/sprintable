// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : undefined);

    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor');

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined);
    const comments = await service.getComments(id, {
      limit: limit ? parseInt(limit, 10) : 20,
      cursor: cursor ?? undefined,
    });

    const hasMore = limit && comments.length > parseInt(limit, 10);
    const data = hasMore ? comments.slice(0, -1) : comments;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]?.created_at : null;

    return apiSuccess(data, { nextCursor });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : undefined);

    const body = await request.json();
    if (!body.content || typeof body.content !== 'string') {
      return ApiErrors.badRequest('content is required');
    }

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined);
    const comment = await service.addComment({
      story_id: id,
      content: body.content,
      created_by: me.id,
    });

    return apiSuccess(comment, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
