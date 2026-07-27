import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST /api/goals/{id}/transition — story #2013. generic PATCH /api/goals/{id}는 BE가 status
 * 변경을 422로 거부(FSM/SoD/gate 우회 방지, routers/goals.py:297) — 전이는 이 전용 엔드포인트로.
 *
 * proxyToFastapiWrapped 사용 이유: 형제 표면 steer-dispatch/route.ts와 동일 근거 — 리포지토리
 * (fastapiCall→mapApiError) 경로는 구조화 에러(HUMAN_CONFIRM_REQUIRED/INVALID_EPIC_TRANSITION의
 * code+message)를 뭉갠다. 이 스토리의 핵심 AC(거부 사유 표면화)가 그 구조화 에러 보존에 의존한다.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/goals/${id}/transition`);
}
