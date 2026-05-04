import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService, type CreateMemoInput } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { parseBody, createMemoSchema } from '@sprintable/shared';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createMemoRepository } from '@/lib/storage/factory';
import { checkEntitlement } from '@/lib/entitlement';
import { incrementUsage } from '@/lib/usage-tracker';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
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

    const ent = await checkEntitlement(supabase, me.org_id, 'memos');
    if (!ent.allowed) return apiError('quota_exceeded', `Memo quota exceeded (${ent.current}/${ent.limit})`, 402, { resource: 'memos', current: ent.current, limit: ent.limit, upgradeUrl: ent.upgradeUrl });

    const parsed = await parseBody(request, createMemoSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    console.warn('[POST /api/memos] parsed assigned_to_ids:', JSON.stringify(body.assigned_to_ids));
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const repo = await createMemoRepository(dbClient);
    const service = new MemoService(repo, dbClient as SupabaseClient | undefined);
    const memo = await service.create({
      ...body,
      org_id: me.org_id,
      project_id: me.project_id,
      created_by: me.id,
    } as CreateMemoInput);
    void incrementUsage(me.org_id, 'memos');
    return apiSuccess(memo, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function GET(request: Request) {
  try {
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

    const { searchParams } = new URL(request.url);
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 30, maxLimit: 100 });
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const repo = await createMemoRepository(dbClient);
    const service = new MemoService(repo, dbClient as SupabaseClient | undefined);
    const memos = await service.list({
      org_id: me.org_id,
      project_id: searchParams.get('project_id') ?? undefined,
      assigned_to: searchParams.get('assigned_to') ?? undefined,
      created_by: searchParams.get('created_by') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(memos, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
