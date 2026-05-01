import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createSprintRepository, createDocRepository } from '@/lib/storage/factory';
import { NotificationService } from '@/services/notification.service';
import { DocsService } from '@/services/docs';
import { requireRole, EDIT_ROLES } from '@/lib/role-guard';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
const ossMode = isOssMode();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbClient: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/close — active→closed + velocity 자동 계산
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (!ossMode && dbClient && me.type !== 'agent') {
      const denied = await requireRole(supabase, me.org_id, EDIT_ROLES, 'Admin or PO access required to close sprint');
      if (denied) return denied;
    }

    const repo = await createSprintRepository();
    const service = new SprintService(repo);
    const sprint = await service.close(id);

    if (!ossMode && dbClient) {
      const db = dbClient as SupabaseClient;

      // 알림 발송 (fire-and-forget)
      const notifService = new NotificationService(db);
      (async () => {
        const { data: members } = await db.from('team_members').select('id').eq('project_id', sprint.project_id).eq('is_active', true);
        for (const member of (members ?? []) as Array<{ id: string }>) {
          await notifService.create({ org_id: sprint.org_id, user_id: member.id, type: 'sprint_closed', title: `${sprint.title ?? '스프린트'} 종료`, reference_type: 'sprint', reference_id: sprint.id });
        }
      })().catch(() => {});

      // 자동 sprint report 생성 (fire-and-forget)
      (async () => {
        const { data: stories } = await db.from('stories').select('id, title, status, story_points, assignee_id').eq('sprint_id', id);
        const allStories = (stories ?? []) as Array<{ id: string; title: string; status: string; story_points: number | null; assignee_id: string | null }>;
        const doneStories = allStories.filter((s) => s.status === 'done');
        const carriedOver = allStories.filter((s) => s.status !== 'done');
        const totalSp = allStories.reduce((sum, s) => sum + (s.story_points ?? 0), 0);
        const doneSp = doneStories.reduce((sum, s) => sum + (s.story_points ?? 0), 0);
        const completionPct = totalSp > 0 ? Math.round((doneSp / totalSp) * 100) : 0;
        const duration = (sprint.duration as number | undefined) ?? 14;
        const velocityPerDay = duration > 0 ? Math.round((doneSp / duration) * 10) / 10 : 0;

        const reportContent = [
          `# Sprint Report: ${sprint.title ?? id}`,
          ``,
          `**기간:** ${sprint.start_date ?? ''} ~ ${sprint.end_date ?? ''}  `,
          `**Duration:** ${duration}일`,
          ``,
          `## 결과 요약`,
          `| 항목 | 수치 |`,
          `|---|---|`,
          `| 완료율 | ${completionPct}% |`,
          `| 완료 SP | ${doneSp} / ${totalSp} |`,
          `| 속도 | ${velocityPerDay} SP/일 |`,
          `| 완료 스토리 | ${doneStories.length} / ${allStories.length} |`,
          ``,
          `## 완료 스토리`,
          ...doneStories.map((s) => `- [x] ${s.title} (${s.story_points ?? 0} SP)`),
          ``,
          `## 이월 스토리`,
          carriedOver.length === 0 ? '_없음_' : '',
          ...carriedOver.map((s) => `- [ ] ${s.title} (${s.story_points ?? 0} SP)`),
        ].join('\n');

        const slug = `sprint-report-${id.slice(0, 8)}-${Date.now()}`;
        const docRepo = await createDocRepository(db);
        const docsService = new DocsService(docRepo, db);
        const doc = await docsService.createDoc({
          org_id: sprint.org_id as string,
          project_id: sprint.project_id as string,
          title: `Sprint Report: ${sprint.title ?? id}`,
          slug,
          content: reportContent,
          content_format: 'markdown',
          doc_type: 'sprint_report',
          created_by: me.id,
        });

        // sprint에 report_doc_id 기록
        const sprintRepo = await createSprintRepository(db);
        await sprintRepo.update(id, { report_doc_id: doc.id });
      })().catch(() => {});

      // 미완료 회고 액션 이월 (fire-and-forget)
      (async () => {
        // 1. 현재 스프린트 retro session 조회
        const { data: closedSession } = await db
          .from('retro_sessions')
          .select('id')
          .eq('sprint_id', id)
          .maybeSingle();
        if (!closedSession) return;

        // 2. 미완료 액션 조회
        const { data: openActions } = await db
          .from('retro_actions')
          .select('title, assignee_id')
          .eq('session_id', closedSession.id)
          .neq('status', 'done');
        if (!openActions?.length) return;

        // 3. 다음 active 스프린트 조회
        const { data: nextSprint } = await db
          .from('sprints')
          .select('id')
          .eq('project_id', sprint.project_id)
          .eq('status', 'active')
          .maybeSingle();
        if (!nextSprint) return;

        // 4. 다음 스프린트 retro session 조회
        const { data: nextSession } = await db
          .from('retro_sessions')
          .select('id')
          .eq('sprint_id', nextSprint.id)
          .maybeSingle();
        if (!nextSession) return;

        // 5. 이월 INSERT
        await db.from('retro_actions').insert(
          openActions.map((a) => ({
            session_id: nextSession.id,
            title: `[이월] ${a.title}`,
            assignee_id: a.assignee_id,
            status: 'open',
          })),
        );
      })().catch(() => {});
    }

    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
