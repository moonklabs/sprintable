import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createDocRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const me = await getOrgProjectAuthContext(request);
  if (!me) return ApiErrors.unauthorized();
  if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
  // Thin proxy to the FastAPI BE, which owns the authoritative slug logic
  // (slug_locked explicit/auto branching, 409 SLUG_TAKEN + suggestion, alias) — that
  // logic does NOT live in DocsService. Forwarding the raw body bypasses
  // parseBody(updateDocSchema): a stale-bundled schema was silently stripping
  // slug/slug_locked (standalone-tracing build non-determinism), so explicit edits
  // got the auto path (silent -N, lock never stuck). proxyToFastapi passes the BE
  // response through verbatim (incl. the 409 error envelope + suggestion) and
  // forwards auth as sp_at cookie → Bearer.
  return proxyToFastapi(request, `/api/v2/docs/${id}`);
}

/** Lightweight timestamp check for remote-change polling */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const repo = await createDocRepository();
    const service = new DocsService(repo, dbClient);
    return apiSuccess(await service.getDocTimestamp(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const repo = await createDocRepository();

    const service = new DocsService(repo, dbClient);
    await service.deleteDoc(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
