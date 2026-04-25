import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBody, updateDocSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';

const EDIT_ROLES = ['owner', 'admin', 'po'] as const;
const ADMIN_ROLES = ['owner', 'admin'] as const;

async function getCallerRole(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  return (data?.role as string) ?? null;
}

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const parsed = await parseBody(request, updateDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);

    if (!ossMode && dbClient) {
      const existing = await repo.getById(id);
      const docType = (existing as unknown as { doc_type?: string }).doc_type ?? 'page';
      if (docType === 'sprint_report') return apiError('FORBIDDEN', 'sprint_report documents are read-only', 403);
      if (docType === 'policy') {
        const role = await getCallerRole(dbClient as SupabaseClient, existing.org_id);
        if (!role || !(EDIT_ROLES as readonly string[]).includes(role)) return ApiErrors.forbidden('Admin or PO access required to edit policy documents');
      }
    }

    const doc = await service.updateDoc(id, {
      ...body,
      created_by: me.id,
      expected_updated_at: body.expected_updated_at,
      force_overwrite: body.force_overwrite,
    });
    return apiSuccess(doc);
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.code === 'CONFLICT') return apiError('CONFLICT', e.message, 409);
    if (e.code === 'NOT_FOUND') return apiError('NOT_FOUND', e.message, 404);
    if (e.code === 'BAD_REQUEST') return apiError('BAD_REQUEST', e.message, 400);
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
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
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
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createDocRepository(dbClient);

    if (!ossMode && dbClient) {
      const existing = await repo.getById(id);
      const docType = (existing as unknown as { doc_type?: string }).doc_type ?? 'page';
      if (docType === 'sprint_report') return apiError('FORBIDDEN', 'sprint_report documents cannot be deleted', 403);
      if (docType === 'policy') {
        const role = await getCallerRole(dbClient as SupabaseClient, existing.org_id);
        if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) return ApiErrors.forbidden('Admin access required to delete policy documents');
      }
    }

    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
