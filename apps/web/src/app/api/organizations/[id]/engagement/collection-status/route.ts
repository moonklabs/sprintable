import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3805(Phase3·3-1·PR 2[FE]) — 연결별 「마지막 수집 시각 / 수집 안 됨」
// (captured_at null=수집 안 됨, 그라운딩 ⑤ — 유나 §절6).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/engagement/collection-status', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
