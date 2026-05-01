import { z } from 'zod';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { MockupService } from '@/services/mockup';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkResourceLimit } from '@/lib/check-feature';
import { isOssMode } from '@/lib/storage/factory';

// MCP tool action schemas
const ListMockupsSchema = z.object({
  action: z.literal('list_mockups'),
  project_id: z.string().uuid(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const GetMockupSchema = z.object({
  action: z.literal('get_mockup'),
  mockup_id: z.string().uuid(),
});

const CreateMockupSchema = z.object({
  action: z.literal('create_mockup'),
  slug: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  viewport: z.enum(['desktop', 'mobile']).optional().default('desktop'),
});

const UpdateMockupSchema = z.object({
  action: z.literal('update_mockup'),
  mockup_id: z.string().uuid(),
  title: z.string().optional(),
  components: z.array(z.object({
    id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    component_type: z.string(),
    props: z.record(z.string(), z.unknown()).optional().default({}),
    spec_description: z.string().nullable().optional(),
    sort_order: z.number().int().optional(),
  })).optional(),
});

const DeleteMockupSchema = z.object({
  action: z.literal('delete_mockup'),
  mockup_id: z.string().uuid(),
});

const ListScenariosSchema = z.object({
  action: z.literal('list_scenarios'),
  mockup_id: z.string().uuid(),
});

const SwitchScenarioSchema = z.object({
  action: z.literal('switch_scenario'),
  mockup_id: z.string().uuid(),
  scenario_name: z.string(),
});

const McpRequestSchema = z.discriminatedUnion('action', [
  ListMockupsSchema,
  GetMockupSchema,
  CreateMockupSchema,
  UpdateMockupSchema,
  DeleteMockupSchema,
  ListScenariosSchema,
  SwitchScenarioSchema,
]);

export async function POST(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = null;
    if (!supabase) return ApiErrors.unauthorized();

    const body = await request.json();
    const parsed = McpRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError('VALIDATION_ERROR', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 400);
    }

    const service = new MockupService(supabase);
    const input = parsed.data;

    switch (input.action) {
      case 'list_mockups': {
        const result = await service.list(input.project_id, input.page, input.limit);
        return apiSuccess(result.items, { total: result.total, page: input.page, limit: input.limit });
      }

      case 'get_mockup': {
        const result = await service.getById(input.mockup_id);
        return apiSuccess(result);
      }

      case 'create_mockup': {
        const me = await getMyTeamMember(supabase, null as any);
        if (!me) return ApiErrors.forbidden('Team member not found');

        const check = await checkResourceLimit(supabase, me.org_id, 'max_mockups', 'mockup_pages');
        if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Mockup limit reached', 403);

        const result = await service.create({
          org_id: me.org_id,
          project_id: me.project_id,
          slug: input.slug,
          title: input.title,
          category: input.category,
          viewport: input.viewport,
          created_by: me.id,
        });
        return apiSuccess(result, undefined, 201);
      }

      case 'update_mockup': {
        const result = await service.update(input.mockup_id, {
          title: input.title,
          components: input.components,
        });
        return apiSuccess(result);
      }

      case 'delete_mockup': {
        await service.delete(input.mockup_id);
        return apiSuccess({ ok: true });
      }

      case 'list_scenarios': {
        const { data, error } = await supabase
          .from('mockup_scenarios')
          .select('id, name, is_default, override_props, sort_order')
          .eq('page_id', input.mockup_id)
          .order('sort_order');
        if (error) throw error;
        return apiSuccess(data);
      }

      case 'switch_scenario': {
        // 기본 컴포넌트 조회
        const { data: components } = await supabase
          .from('mockup_components')
          .select('id, parent_id, component_type, props, sort_order')
          .eq('page_id', input.mockup_id)
          .order('sort_order');

        // 시나리오 조회
        const { data: scenario } = await supabase
          .from('mockup_scenarios')
          .select('name, override_props, is_default')
          .eq('page_id', input.mockup_id)
          .eq('name', input.scenario_name)
          .single();

        if (!scenario) return ApiErrors.notFound('Scenario not found');

        const overrides = (scenario.override_props ?? {}) as Record<string, Record<string, unknown>>;
        const merged = (components ?? []).map(c => ({
          ...c,
          props: overrides[c.id] ? { ...(c.props as Record<string, unknown>), ...overrides[c.id] } : c.props,
        }));

        return apiSuccess({ scenario: scenario.name, is_default: scenario.is_default, components: merged });
      }
    }
  } catch (err: unknown) { return handleApiError(err); }
}
