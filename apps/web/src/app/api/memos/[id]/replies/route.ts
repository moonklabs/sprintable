import { parseBody, createMemoReplySchema } from '@sprintable/shared';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode, createMemoRepository, createTeamMemberRepository } from '@/lib/storage/factory';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
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

    if (isOssMode()) {
      const parsed = await parseBody(request, createMemoReplySchema);
      if (!parsed.success) return parsed.response;
      const body = parsed.data;
      const repo = await createMemoRepository();
      const teamMemberRepo = await createTeamMemberRepository();
      const service = new MemoService(repo, undefined, teamMemberRepo);
      const resolvedIds = body.assigned_to_ids ?? (body.assigned_to ? [body.assigned_to] : undefined);
      const reply = await service.addReply(id, body.content, me.id, 'comment', resolvedIds);
      return apiSuccess(reply, undefined, 201);
    }

    return proxyToFastapiWithParams(request, '/api/v2/memos/[id]/replies', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
