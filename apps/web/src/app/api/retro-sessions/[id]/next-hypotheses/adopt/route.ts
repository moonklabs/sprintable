import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/retro-sessions/:id/next-hypotheses/adopt — E-SPRINT-LOOP(1b9f4ecb) §5 L3 [채택].
// body = 채택된 추천 페이로드 전체(ephemeral 추천이라 서버측 id 대신 payload 직접 전달,
// HypothesisDraftRequest persist 흐름과 동형). 성공 시 다음 스프린트 hypothesis를 proposed로
// 시드하고 팀 확정을 기다린다(requires_confirmation — 인간 게이트, PO 결 확정 시드 규칙).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapi(request, `/api/v2/retros/${id}/next-hypotheses/adopt`);
  if (!_r.ok) return _r;
  // 까심 QA 적출: 204(빈 바디)에 .json()을 그대로 호출하면 파싱 크래시 — 선처리 필요.
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
