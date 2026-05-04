import { MemoService, type CreateMemoInput } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { parseBody, createMemoSchema, MEMO_TYPES_REQUIRING_ASSIGNEE } from '@sprintable/shared';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createMemoRepository, createTeamMemberRepository, createProjectRepository } from '@/lib/storage/factory';
import { apiError } from '@/lib/api-response';

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
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

    const parsed = await parseBody(request, createMemoSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    // task/request/feedback 타입은 assigned_to 필수
    if (body.memo_type && (MEMO_TYPES_REQUIRING_ASSIGNEE as readonly string[]).includes(body.memo_type)) {
      const hasAssignee = (body.assigned_to_ids && body.assigned_to_ids.length > 0) || body.assigned_to;
      if (!hasAssignee) {
        return apiError('BAD_REQUEST', `memo_type '${body.memo_type}' requires at least one assignee`, 400);
      }
    }
    const dbClient = undefined;
    const repo = await createMemoRepository();
    const teamMemberRepo = await createTeamMemberRepository();
    const projectRepo = await createProjectRepository();
    const service = new MemoService(repo, dbClient, teamMemberRepo, projectRepo);
    const memo = await service.create({
      ...body,
      org_id: me.org_id,
      project_id: me.project_id,
      created_by: me.id,
    } as CreateMemoInput);
    return apiSuccess(memo, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
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
    const dbClient = undefined;
    const repo = await createMemoRepository();
    const service = new MemoService(repo, dbClient);
    const memos = await service.list({
      org_id: me.org_id,
      project_id: searchParams.get('project_id') ?? undefined,
      assigned_to: searchParams.get('assigned_to') ?? undefined,
      created_by: searchParams.get('created_by') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      include_archived: searchParams.get('include_archived') === 'true',
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(memos, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
