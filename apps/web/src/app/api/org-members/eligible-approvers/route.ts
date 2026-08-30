import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3231 2라운드(카디르 QA) — org-members roster(GET /api/org-members)를 admin
// 전용으로 잠그면서 doc-gate-section.tsx의 결재자 지정 픽커가 연쇄 파손됐다. 이 경로는
// 그 픽커 전용 — 어떤 role의 Member도 호출 가능하되 BE가 owner/admin만 반환한다.
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/org-members/eligible-approvers');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}
