import { parseBody, createMemoReplySchema } from '@sprintable/shared';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

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

    const parsed = await parseBody(request, createMemoReplySchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const { fastapiCall } = await import('@sprintable/storage-api');
    const xApiKey = request.headers.get('x-api-key');
    const authHeader = request.headers.get('authorization');
    const rawApiKey = xApiKey ?? (authHeader?.startsWith('Bearer sk_live_') ? authHeader.slice(7) : null);
    const { getServerSession } = await import('@/lib/db/server');
    const session = await getServerSession();
    const token = rawApiKey ?? session?.access_token ?? '';

    const resolvedIds = body.assigned_to_ids ?? (body.assigned_to ? [body.assigned_to] : undefined);
    const reply = await fastapiCall<unknown>(
      'POST', `/api/v2/memos/${id}/replies`, token,
      {
        body: {
          content: body.content,
          created_by: me.id,
          review_type: 'comment',
          ...(resolvedIds ? { assigned_to_ids: resolvedIds } : {}),
        },
      },
    );
    return apiSuccess(reply, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
