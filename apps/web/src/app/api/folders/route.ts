import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/folders?project_id → FastAPI /api/v2/folders (Folder[])
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/folders');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}

// POST /api/folders { name, project_id?, parent_id? } → FastAPI /api/v2/folders (story #1939)
// 409(같은 위치 중복 이름)·403(project 접근 없음)·404(parent 스코프 밖)는 BE 응답 그대로 통과
// (proxyToFastapi가 status/body 원본 유지) — FE는 이 상태코드로 UX 분기.
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/folders');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
