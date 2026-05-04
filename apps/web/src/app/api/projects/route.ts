import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { isOssMode, createProjectRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-pglite');
      const repo = await createProjectRepository();
      const project = await repo.getById(OSS_PROJECT_ID);
      return apiSuccess(project ? [{ id: project.id, name: project.name, description: null, org_id: OSS_ORG_ID }] : []);
    }
const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 */
export async function POST(request: Request) {
const _r = await proxyToFastapi(request, '/api/v2/projects');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
