import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 시나리오 목록 */
export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess([]);
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = null;
    const { data: { user } } = await db.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { data, error } = await db
      .from('mockup_scenarios')
      .select('*')
      .eq('page_id', id)
      .order('sort_order');

    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 시나리오 생성 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = null;
    const { data: { user } } = await db.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json();
    const { data, error } = await db
      .from('mockup_scenarios')
      .insert({ page_id: id, name: body.name ?? 'New Scenario', override_props: body.override_props ?? {}, is_default: false })
      .select()
      .single();

    if (error) throw error;
    return apiSuccess(data, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}

/** PATCH — 시나리오 수정 */
export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = null;
    const { data: { user } } = await db.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json();
    if (!body.scenario_id) return ApiErrors.badRequest('scenario_id required');

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.override_props !== undefined) updates.override_props = body.override_props;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

    const { error } = await db.from('mockup_scenarios').update(updates).eq('id', body.scenario_id).eq('page_id', id);
    if (error) throw error;
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}

/** DELETE — 시나리오 삭제 (default 불가) */
export async function DELETE(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  try {
    const { id } = await params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = null;
    const { data: { user } } = await db.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json();
    if (!body.scenario_id) return ApiErrors.badRequest('scenario_id required');

    // default 삭제 방지 + page scope
    const { data: scenario } = await db.from('mockup_scenarios').select('is_default').eq('id', body.scenario_id).eq('page_id', id).single();
    if (scenario?.is_default) return apiError('CANNOT_DELETE_DEFAULT', 'Cannot delete default scenario', 400);

    const { error } = await db.from('mockup_scenarios').delete().eq('id', body.scenario_id).eq('page_id', id);
    if (error) throw error;
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
