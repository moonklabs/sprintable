import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * GET /api/hypotheses/{id}/lifecycle — story #2533(E-FLOW-V4 S3). BE
 * `GET /api/v2/hypotheses/{id}/lifecycle`(story #2533-BE, hypotheses.py:178)를 그대로
 * 통과시킨다. 응답 = `{hypothesis, goals[], stories[], superseded_by, supersedes[],
 * timeline}`(원시 어휘, 래핑 없음) — `HypothesisNarrativePanel`(가설 생애 수직 서사)이
 * 단일 요청으로 5축(질문·목표·검증·증명·정반합·시간선)을 조립하는 유일한 소스.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/hypotheses/[id]/lifecycle', { id });
}
