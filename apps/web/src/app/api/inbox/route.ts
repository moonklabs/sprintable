import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { isOssMode, createInboxItemRepository } from '@/lib/storage/factory';

/** GET — inbox 목록 (/api/v2/inbox proxy, assignee_member_id 자동 주입) */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const url = new URL(request.url);
      const stateParam = url.searchParams.get('state') ?? undefined;
      const kindParam = url.searchParams.get('kind') ?? undefined;
      const repo = await createInboxItemRepository();
      const items = await repo.list({
        org_id: me.org_id,
        assignee_member_id: me.id,
        ...(stateParam ? { state: stateParam as 'pending' | 'resolved' | 'dismissed' } : {}),
        ...(kindParam ? { kind: kindParam as 'approval' | 'decision' | 'blocker' | 'mention' } : {}),
      });
      return apiSuccess(items);
    }

    const url = new URL(request.url);
    url.searchParams.set('assignee_member_id', me.id);

    const _r = await proxyToFastapi(
      new Request(url.toString(), { method: 'GET', headers: request.headers }),
      '/api/v2/inbox',
    );
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
