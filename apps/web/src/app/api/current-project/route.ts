import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { parseBody, setCurrentProjectSchema } from '@sprintable/shared';
import { isOssMode } from '@/lib/storage/factory';

export async function POST(request: Request) {
  if (isOssMode()) {
    const { OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    return apiSuccess({ project_id: OSS_PROJECT_ID, project_name: 'My Project' });
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, setCurrentProjectSchema);
    if (!parsed.success) return parsed.response;
    const { project_id: projectId } = parsed.data;

    const { data: membership, error } = await supabase
      .from('team_members')
      .select('id, project_id, projects(name)')
      .eq('user_id', user.id)
      .eq('type', 'human')
      .eq('is_active', true)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) throw error;
    if (!membership) return ApiErrors.forbidden('Project membership not found');

    const cookieStore = await cookies();
    cookieStore.set(CURRENT_PROJECT_COOKIE, projectId, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });

    const project = Array.isArray(membership.projects)
      ? membership.projects.find(Boolean)
      : membership.projects;

    return apiSuccess({
      project_id: membership.project_id,
      project_name: (project as { name: string } | null)?.name ?? null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
