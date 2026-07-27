import { parseBody, createDocSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { parseCursorPageInput } from '@/lib/pagination';
import { checkResourceLimit } from '@/lib/check-feature';
import { createDocRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');
    const repo = await createDocRepository();
    const service = new DocsService(repo, dbClient);
    const slug = searchParams.get('slug');
    if (slug) return apiSuccess(await service.getDoc(projectId, slug));

    // story #2191(#2231 규약 A) — "view=tree" 전용 무커서 경로를 소거했다. BE 라우터는
    // parent_id 유무로만 tree/list를 가르는데 이 route는 project_id만 보내 애초에 항상
    // 일반 list() 분기로 떨어지고 있었다("tree 분기"는 실재하지 않았다) — 사이드바 문서
    // 트리(기본 진입)도 태그 필터와 완전히 같은 커서 경로를 탄다. limit='20' 죽은
    // 파라미터도 여기서 함께 정리(BE가 이제 실제로 cursor/limit을 받는다).
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 40, maxLimit: 100 });
    const query = searchParams.get('q');
    const tagsParam = searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const result = query
      ? await service.search(projectId, query, { ...pageInput, tags })
      : await service.list(projectId, { ...pageInput, tags });
    // ⛔BE가 has_more/next_cursor를 직접 계산해 낸다(#2540) — FE는 그 값을 그대로 믿는다.
    // buildCursorPageMeta로 재추론하지 않는다(재추론은 오늘 여러 번 확認한 "같은 것을
    // 두 곳에서 계산하는" 병의 근원).
    return apiSuccess(result.items, { hasMore: result.hasMore, nextCursor: result.nextCursor });
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const check = await checkResourceLimit(dbClient, me.org_id, 'max_docs', 'docs');
    if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Document limit reached. Upgrade to Team.', 403);
    const parsed = await parseBody(request, createDocSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository();
    const service = new DocsService(repo, dbClient);
    const doc = await service.createDoc({
      org_id: me.org_id, project_id: me.project_id,
      title: body.title, slug: body.slug ?? '', content: body.content ?? '', content_format: body.content_format ?? 'markdown',
      icon: body.icon ?? null, tags: body.tags ?? [],
      parent_id: body.parent_id ?? undefined, is_folder: body.is_folder ?? false, created_by: me.id,
    });
    return apiSuccess(doc, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
