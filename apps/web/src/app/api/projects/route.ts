import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError } from '@/lib/api-response';
import { createProjectRepository } from '@/lib/storage/factory';

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

/** POST — 프로젝트 생성 (OSS 미지원) */
export async function POST(_request: Request) {
  return apiError('NOT_IMPLEMENTED', 'Project creation is not supported in OSS mode.', 501);
}
