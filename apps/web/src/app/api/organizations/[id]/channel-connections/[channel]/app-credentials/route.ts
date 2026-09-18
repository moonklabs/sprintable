import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3376, PR#3736 실 계약 — GET은 member 이상(effective_source·configured·
// app_id_suffix만, secret 전무). PUT은 owner 전용(app_id·app_secret 평문 바디를 그대로
// 서버에 전달만 — FE는 저장 전 secret을 절대 로그·상태에 남기지 않는다, 폼 제출 즉시
// 값을 버린다).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/app-credentials', { id, channel },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/app-credentials', { id, channel },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
