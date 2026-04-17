import { parseBody, updateDocSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const parsed = await parseBody(request, updateDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const service = new DocsService(dbClient);
    const doc = await service.updateDoc(id, {
      ...body,
      created_by: me.id,
      expected_updated_at: body.expected_updated_at,
      force_overwrite: body.force_overwrite,
    });
    return apiSuccess(doc);
  } catch (err: unknown) {
    const maybeConflict = err as Error & { code?: string };
    if (maybeConflict.code === 'CONFLICT') {
      return apiError('CONFLICT', maybeConflict.message, 409);
    }
    return handleApiError(err);
  }
}

/** Lightweight timestamp check for remote-change polling */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new DocsService(dbClient);
    return apiSuccess(await service.getDocTimestamp(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new DocsService(dbClient);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
