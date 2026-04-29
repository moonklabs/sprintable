import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBody, updateDocSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';
import { getTeamMemberRole, hasRole } from '@/lib/doc-permissions';

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

    const parsed = await parseBody(request, updateDocSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    if (!ossMode && me.type !== 'agent') {
      const role = await getTeamMemberRole(supabase, me.id);
      // 폴더 이동/구조 변경은 owner 이상
      if ('parent_id' in body || 'is_folder' in body) {
        if (!role || !hasRole(role, 'owner')) {
          return apiError('FORBIDDEN', 'Folder structure changes require owner role', 403);
        }
      } else if (!role || !hasRole(role, 'admin')) {
        // 일반 문서 수정은 admin 이상
        return apiError('FORBIDDEN', 'Document editing requires admin or owner role', 403);
      }
    }

    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
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

    if (!ossMode && me.type !== 'agent') {
      const role = await getTeamMemberRole(supabase, me.id);
      if (!role || !hasRole(role, 'admin')) {
        return apiError('FORBIDDEN', 'Document deletion requires admin or owner role', 403);
      }
    }

    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
