import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { createProjectRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(_request: Request) {
  try {
    const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    const repo = await createProjectRepository();
    const project = await repo.getById(OSS_PROJECT_ID);
    return apiSuccess(project ? [{ id: project.id, name: project.name, description: null, org_id: OSS_ORG_ID }] : []);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/projects');
}
