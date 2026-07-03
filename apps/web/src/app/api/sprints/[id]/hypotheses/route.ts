import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/hypotheses — E-SPRINT-LOOP retro sprint-close cockpit(1b9f4ecb) §5 소스.
// HypothesisSprintLink 집계(BE story a4acc4d0, 디디 병행) 미착지 구간엔 BE가 404를 그대로 반환 —
// 소비부(SprintCloseCockpit)가 non-2xx를 빈 배열로 흡수해 렌더(nullable graceful, 크래시 0).
// 응답 shape은 배열(RetroHypothesisResult[])이라 204도 `[]`로 통일 — 까심 QA 적출: {ok:true}
// 객체를 배열 자리에 넣으면 소비부 .filter/.every가 크래시.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapi(request, `/api/v2/sprints/${id}/hypotheses`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}

// POST /api/sprints/:id/hypotheses — E-SPRINT-LOOP sprint-open 定(278314e9) §5 가설 선언.
// body: 새 가설={statement, metric_definition, measure_after} | 기존 링크={hypothesis_id}
// (BE story a353e88d, PR #1867, crux 중 — 계약 확정 전이라 소비부가 non-2xx를 인라인 에러로
// 흡수·크래시 0, 자동 submit 없음).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapi(request, `/api/v2/sprints/${id}/hypotheses`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
