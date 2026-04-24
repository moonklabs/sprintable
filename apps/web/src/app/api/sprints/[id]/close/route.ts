import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createSprintRepository } from '@/lib/storage/factory';
import { NotificationService } from '@/services/notification.service';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/close — active→closed + velocity 자동 계산
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient as SupabaseClient | undefined);
    const sprint = await service.close(id);

    if (!ossMode && dbClient) {
      const notifService = new NotificationService(dbClient as SupabaseClient);
      (async () => {
        const { data: members } = await (dbClient as SupabaseClient)
          .from('team_members')
          .select('id')
          .eq('project_id', sprint.project_id)
          .eq('is_active', true);
        for (const member of (members ?? []) as Array<{ id: string }>) {
          await notifService.create({
            org_id: sprint.org_id,
            user_id: member.id,
            type: 'sprint_closed',
            title: `${sprint.title ?? '스프린트'} 종료`,
            reference_type: 'sprint',
            reference_id: sprint.id,
          });
        }
      })().catch(() => {});
    }

    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
