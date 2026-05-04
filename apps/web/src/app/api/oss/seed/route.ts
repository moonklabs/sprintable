import { isOssMode, createStoryRepository, createProjectRepository } from '@/lib/storage/factory';
import { apiSuccess, apiError } from '@/lib/api-response';

const SAMPLE_STORIES = [
  { title: 'SPR-1: GitHub Webhook 연동하기', status: 'backlog' as const, priority: 'high' as const },
  { title: 'SPR-2: 첫 번째 스프린트 계획', status: 'in-progress' as const, priority: 'medium' as const },
  { title: 'SPR-3: Hello Sprintable!', status: 'done' as const, priority: 'low' as const },
];

export async function POST() {
  if (!isOssMode()) {
    return apiError('NOT_AVAILABLE', 'Seed is only available in OSS mode', 403);
  }

  try {
    const { getOssUserContext } = await import('@/lib/auth-helpers');
    const { me } = await getOssUserContext();
    if (!me) return apiError('NOT_AVAILABLE', 'No project context', 503);
    const { project_id: OSS_PROJECT_ID, org_id: OSS_ORG_ID } = me;

    const storyRepo = await createStoryRepository();
    const existing = await storyRepo.list({ project_id: OSS_PROJECT_ID, limit: 1 });

    if (existing.length > 0) {
      return apiSuccess({ seeded: false, reason: 'already_has_data' });
    }

    // Ensure project name is set
    try {
      const projectRepo = await createProjectRepository();
      await projectRepo.update(OSS_PROJECT_ID, { name: 'Hello Sprintable' });
    } catch {
      // Project update is best-effort; proceed with story seeding
    }

    for (const story of SAMPLE_STORIES) {
      await storyRepo.create({
        project_id: OSS_PROJECT_ID,
        org_id: OSS_ORG_ID,
        title: story.title,
        status: story.status,
        priority: story.priority,
      });
    }

    return apiSuccess({ seeded: true, count: SAMPLE_STORIES.length });
  } catch (err) {
    console.error('[oss/seed] Failed:', err);
    return apiError('SEED_FAILED', 'Failed to seed sample data', 500);
  }
}
