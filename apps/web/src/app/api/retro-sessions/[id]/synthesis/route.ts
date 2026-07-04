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
  // 까심 QA 적출: 204(빈 바디)에 .json()을 그대로 호출하면 파싱 크래시 — 선처리 필요.
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
