import { parseBody, createMemoReplySchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createMemoRepository, createTeamMemberRepository, isOssMode } from '@/lib/storage/factory';
import type { SupabaseClient } from '@supabase/supabase-js';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '300',
            'X-RateLimit-Remaining': String(me.rateLimitRemaining ?? 0),
            'X-RateLimit-Reset': String(me.rateLimitResetAt ?? 0),
          },
        }
      );
    }

    const parsed = await parseBody(request, createMemoReplySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const dbClient = isOssMode() ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createMemoRepository(dbClient);
    const teamMemberRepo = isOssMode() ? await createTeamMemberRepository() : undefined;
    const service = new MemoService(repo, dbClient as SupabaseClient | undefined, teamMemberRepo);
    const resolvedIds = body.assigned_to_ids ?? (body.assigned_to ? [body.assigned_to] : undefined);
    const reply = await service.addReply(id, body.content, me.id, 'comment', resolvedIds);
    return apiSuccess(reply, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
