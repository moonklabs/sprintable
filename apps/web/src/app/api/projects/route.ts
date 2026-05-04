import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const { getDb } = await import('@sprintable/storage-pglite');
      const db = await getDb();
      const projects = (await db.query('SELECT id, name, org_id FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC')).rows as Array<{ id: string; name: string; org_id: string }>;
      return apiSuccess(projects.map((p) => ({ id: p.id, name: p.name, description: null, org_id: p.org_id })));
    }
const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 */
export async function POST(request: Request) {
const _r = await proxyToFastapi(request, '/api/v2/projects');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json())
}
