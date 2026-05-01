import { cookies } from 'next/headers';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { parseBody, setCurrentProjectSchema } from '@sprintable/shared';
import { createProjectRepository } from '@/lib/storage/factory';

export async function GET() {
  try {
    const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-sqlite');
    const repo = await createProjectRepository();
    const project = await repo.getById(OSS_PROJECT_ID);
    return apiSuccess({
      project_id: OSS_PROJECT_ID,
      project_name: project?.name ?? 'My Project',
      org_id: OSS_ORG_ID,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const { OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    const parsed = await parseBody(request, setCurrentProjectSchema);
    if (!parsed.success) return parsed.response;
    const { project_id: projectId } = parsed.data;

    if (projectId !== OSS_PROJECT_ID) return ApiErrors.forbidden('Project membership not found');

    const cookieStore = await cookies();
    cookieStore.set(CURRENT_PROJECT_COOKIE, projectId, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });

    const repo = await createProjectRepository();
    const project = await repo.getById(OSS_PROJECT_ID);
    return apiSuccess({
      project_id: projectId,
      project_name: project?.name ?? 'My Project',
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
