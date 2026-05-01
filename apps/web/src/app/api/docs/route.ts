import { parseBody, createDocSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { checkResourceLimit } from '@/lib/check-feature';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';
const ossMode = isOssMode();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbClient: any = undefined;

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const repo = await createDocRepository();
    const service = new DocsService(repo);
    const slug = searchParams.get('slug');
    if (slug) return apiSuccess(await service.getDoc(projectId, slug));

    if (searchParams.get('view') === 'tree') {
      return apiSuccess(await service.getTree(projectId), {
        mode: 'tree',
        exception: 'hierarchy_preserving_tree_browse',
      });
    }

    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 40, maxLimit: 100 });
    const query = searchParams.get('q');
    const tagsParam = searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const rows = query
      ? await service.search(projectId, query, { ...pageInput, tags })
      : await service.list(projectId, { ...pageInput, tags });
    const { page, meta } = buildCursorPageMeta(rows as any[], pageInput.limit, 'updated_at' as any);
    return apiSuccess(page, meta);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    if (!ossMode) {
      const check = await checkResourceLimit(dbClient!, me.org_id, 'max_docs', 'docs');
      if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Document limit reached. Upgrade to Team.', 403);
    }
    const parsed = await parseBody(request, createDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository();
    const service = new DocsService(repo);
    const doc = await service.createDoc({
      org_id: me.org_id, project_id: me.project_id,
      title: body.title, slug: body.slug ?? '', content: body.content ?? '', content_format: body.content_format ?? 'markdown',
      icon: body.icon ?? null, tags: body.tags ?? [],
      parent_id: body.parent_id ?? undefined, is_folder: body.is_folder ?? false, created_by: me.id,
    });
    return apiSuccess(doc, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
