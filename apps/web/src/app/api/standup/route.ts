
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { isOssMode } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { saveStandupSchema } from '@sprintable/shared';
import { getOssStandupEntryForUser, listOssStandupEntries, saveOssStandupEntry } from '@/lib/oss-standup';

// GET /api/standup?project_id=...&date=YYYY-MM-DD[&member_id=...]
export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id');
      const date = searchParams.get('date');
      const memberId = searchParams.get('member_id');
      if (!projectId || !date) return ApiErrors.badRequest('project_id and date required');

      if (memberId) {
        return apiSuccess(await getOssStandupEntryForUser(projectId, memberId, date));
      }
      return apiSuccess(await listOssStandupEntries(projectId, date));
    }

const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/standup — supports Dual Auth; agent may pass author_id in body
export async function POST(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

      let rawBody: unknown;
      try { rawBody = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }

      const authorId: string =
        me.type === 'agent' && typeof (rawBody as Record<string, unknown>).author_id === 'string'
          ? (rawBody as Record<string, unknown>).author_id as string
          : me.id;

      const parsed = saveStandupSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return ApiErrors.validationFailed(issues);
      }
      const body = parsed.data;

      const entry = await saveOssStandupEntry({
        project_id: me.project_id,
        org_id: me.org_id,
        author_id: authorId,
        date: body.date || new Date().toISOString().slice(0, 10),
        done: body.done ?? null,
        plan: body.plan ?? null,
        blockers: body.blockers ?? null,
        sprint_id: body.sprint_id ?? null,
        plan_story_ids: body.plan_story_ids ?? [],
      });
      return apiSuccess(entry);
    }

const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PUT /api/standup — kept for backwards compatibility (human auth only)
export async function PUT(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

      let rawBody: unknown;
      try { rawBody = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }

      const parsed = saveStandupSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return ApiErrors.validationFailed(issues);
      }
      const body = parsed.data;

      const entry = await saveOssStandupEntry({
        project_id: me.project_id,
        org_id: me.org_id,
        author_id: me.id,
        date: body.date || new Date().toISOString().slice(0, 10),
        done: body.done ?? null,
        plan: body.plan ?? null,
        blockers: body.blockers ?? null,
        sprint_id: body.sprint_id ?? null,
        plan_story_ids: body.plan_story_ids ?? [],
      });
      return apiSuccess(entry);
    }

const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
