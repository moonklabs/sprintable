import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext, CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { cookies } from 'next/headers';
import {
  isOssMode,
  createInboxItemRepository,
} from '@/lib/storage/factory';
import { INBOX_KINDS, INBOX_STATES } from '@sprintable/shared';
import type { InboxKind, InboxState } from '@sprintable/core-storage';

/** GET — inbox 목록 (현재 project + 본인 assignee 기준, state=pending 기본) */
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const ossMode = isOssMode();
    const dbClient: SupabaseClient | undefined = ossMode
      ? undefined
      : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

    const { searchParams } = new URL(request.url);
    const kindParam = searchParams.get('kind');
    const stateParam = searchParams.get('state') ?? 'pending';
    const cursor = searchParams.get('cursor') ?? undefined;
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1), 100);

    if (kindParam && !INBOX_KINDS.includes(kindParam as InboxKind)) {
      return ApiErrors.badRequest(`Invalid kind: ${kindParam}`);
    }
    if (!INBOX_STATES.includes(stateParam as InboxState)) {
      return ApiErrors.badRequest(`Invalid state: ${stateParam}`);
    }

    // project_id 우선순위: query → cookie → me.project_id
    const cookieStore = await cookies();
    const projectIdFromCookie = cookieStore.get(CURRENT_PROJECT_COOKIE)?.value;
    const projectId = searchParams.get('project_id') ?? projectIdFromCookie ?? me.project_id;

    const repo = await createInboxItemRepository(dbClient);
    const items = await repo.list({
      org_id: me.org_id,
      project_id: projectId,
      assignee_member_id: me.id,
      kind: kindParam ? (kindParam as InboxKind) : undefined,
      state: stateParam as InboxState,
      cursor,
      limit,
    });

    const counts = await repo.count({
      org_id: me.org_id,
      project_id: projectId,
      assignee_member_id: me.id,
      state: 'pending',
    });

    return apiSuccess(items, {
      pendingCount: counts.total,
      countsByKind: counts.byKind,
      nextCursor: items.length === limit ? items[items.length - 1]!.created_at : null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
