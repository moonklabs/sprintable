import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBody, createStorySchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { StoryService, type CreateStoryInput } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkEntitlement } from '@/lib/entitlement';
import { incrementUsage } from '@/lib/usage-tracker';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createStoryRepository } from '@/lib/storage/factory';
import { WorkflowContractService } from '@/services/workflow-contract-service';
import { GateCheckService } from '@/services/gate-check-service';

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const ent = await checkEntitlement(supabase, me.org_id, 'stories');
    if (!ent.allowed) return apiError('quota_exceeded', `Story quota exceeded (${ent.current}/${ent.limit})`, 402, { resource: 'stories', current: ent.current, limit: ent.limit, upgradeUrl: ent.upgradeUrl });

    const rawBody = await request.json();
    if (!rawBody.project_id) rawBody.project_id = me.project_id;
    if (!rawBody.org_id) rawBody.org_id = me.org_id;
    const parsed = createStorySchema.safeParse(rawBody);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined);
    const story = await service.create(parsed.data as CreateStoryInput);
    void incrementUsage(me.org_id, 'stories');

    // 활성 story 계약에 자동 인스턴스 바인딩 (fire-and-forget)
    void (async () => {
      try {
        const admin = createSupabaseAdminClient();
        const contracts = await new WorkflowContractService(admin).list(me.org_id, 'story', story.project_id ?? undefined);
        if (contracts.length > 0) {
          const gateSvc = new GateCheckService(admin);
          await Promise.all(
            contracts.map((c) =>
              gateSvc.createInstance(c.id, story.id, c.definition.initial_state)
            )
          );
        }
      } catch {
        // story 생성은 성공 — 인스턴스 바인딩 실패가 응답을 막지 않음
      }
    })();

    return apiSuccess(story, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { searchParams } = new URL(request.url);
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });
    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as SupabaseClient | undefined);
    const stories = await service.list({
      sprint_id: searchParams.get('sprint_id') ?? undefined,
      epic_id: searchParams.get('epic_id') ?? undefined,
      assignee_id: searchParams.get('assignee_id') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      project_id: searchParams.get('project_id') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      unassigned: searchParams.get('unassigned') === 'true' ? true : undefined,
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(stories, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
