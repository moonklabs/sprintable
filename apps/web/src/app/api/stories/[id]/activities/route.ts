import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
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
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor');

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined);
    const activities = await service.getActivities(id, {
      limit: limit ? parseInt(limit, 10) : 20,
      cursor: cursor ?? undefined,
    });

    const hasMore = limit && activities.length > parseInt(limit, 10);
    const data = hasMore ? activities.slice(0, -1) : activities;
    const nextCursor = hasMore && data.length > 0 ? (data[data.length - 1] as { created_at?: string })?.created_at : null;

    return apiSuccess(data, { nextCursor });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
