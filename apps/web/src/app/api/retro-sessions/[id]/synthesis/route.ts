import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/retro-sessions/:id/synthesis — E-SPRINT-LOOP(1b9f4ecb) §5 L2 "배운 것" + L3 다음가설
// 추천을 함께 on-demand 생성(PO 결: 트리거=on-demand). BE 미착지 구간엔 non-2xx 그대로 통과 —
// 소비부가 에러 토스트로 흡수하고 "종합 생성" CTA를 유지한다(크래시 0).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapi(request, `/api/v2/retros/${id}/synthesis`);
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
