import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createTeamMemberSchema } from '@sprintable/shared';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getServerSession } from '@/lib/db/server';

export async function GET(request: Request) {
  try {
    const res = await proxyToFastapi(request, '/api/v2/team-members');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 멤버 추가/재활성화 */
export async function POST(request: Request) {
  try {
    const rawBody = JSON.parse(await request.text()) as Record<string, unknown>;

    // human 타입: user_id를 세션에서 자동 주입 (클라이언트가 전달하지 않아도 됨)
    if (!rawBody['type'] || rawBody['type'] === 'human') {
      if (!rawBody['user_id']) {
        const session = await getServerSession();
        if (!session) return ApiErrors.unauthorized();
        rawBody['user_id'] = session.user_id;
      }
    }

    const parsed = createTeamMemberSchema.safeParse(rawBody);
    if (!parsed.success) return ApiErrors.validationFailed(
      parsed.error.issues.map(e => ({ path: String(e.path.join('.')), message: e.message }))
    );

    // 검증된 body로 새 Request를 만들어 FastAPI로 proxy (원본 request body는 이미 소비됨)
    const proxied = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(rawBody),
    });
    const _r = await proxyToFastapi(proxied, '/api/v2/team-members');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
