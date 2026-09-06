import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3583(페드루 PO 確定 2026-09-06) — status='property_pending'(토큰 저장 済·
// 속성 미선택)일 때만 화면이 이 목록을 부른다 — 다른 status에서는 호출 자체가 없다.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/measurement-connections/ga4/properties', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
