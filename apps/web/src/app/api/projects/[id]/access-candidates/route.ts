import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3231 4라운드(카디르 QA) — project-access-section.tsx의 후보 로스터 전용. BE가
// list_project_access와 동일 게이트(_require_owner_or_admin, 프로젝트 effective 역할)로
// 인가한다 — org-members roster(org admin 전용)는 안 건드림.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/access-candidates', { id });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}
