import { cookies } from 'next/headers';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { CURRENT_PROJECT_COOKIE, getAuthContext } from '@/lib/auth-helpers';
import { parseBody, setCurrentProjectSchema } from '@sprintable/shared';
;

export async function GET(request: Request) {
  try {
    // 비-OSS: getAuthContext → me에 org_id, project_id 포함
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const { fastapiCall } = await import('@sprintable/storage-api');
    const { getServerSession } = await import('@/lib/db/server');
    const session = await getServerSession();
    const token = session?.access_token ?? '';

    let projectName = 'My Project';
    try {
      const proj = await fastapiCall<{ name?: string; id?: string }>(
        'GET', `/api/v2/projects/${me.project_id}`, token,
      );
      projectName = proj?.name ?? 'My Project';
    } catch { /* fallback to default */ }

    return apiSuccess({
      project_id: me.project_id,
      project_name: projectName,
      org_id: me.org_id,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, setCurrentProjectSchema);
    if (!parsed.success) return parsed.response;
    const { project_id: projectId } = parsed.data;

    // 비-OSS: 쿠키에 project_id 저장 + fastapiCall로 프로젝트 정보 조회
    const cookieStore = await cookies();
    cookieStore.set(CURRENT_PROJECT_COOKIE, projectId, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });

    const { fastapiCall } = await import('@sprintable/storage-api');
    const { getServerSession } = await import('@/lib/db/server');
    const session = await getServerSession();
    const token = session?.access_token ?? '';

    let projectName = 'My Project';
    try {
      const proj = await fastapiCall<{ name?: string; id?: string }>(
        'GET', `/api/v2/projects/${projectId}`, token,
      );
      projectName = proj?.name ?? 'My Project';
    } catch { /* fallback to default */ }

    return apiSuccess({
      project_id: projectId,
      project_name: projectName,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
