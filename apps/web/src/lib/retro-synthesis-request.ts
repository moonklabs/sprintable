// story #4336 PR2 ②(PO 04:32Z) — 회고 종합(L2) + 다음 가설(L3) 요청. 종합은 늘 작업(retro_synthesis): 202 + 작업 → 워커가 LLM 두 번을
// 마치면 작업 상태 보기의 result.session(예전 200 본문과 같은 모양). `signal`이 끊기면(화면을 떠남) 묻기만 멈추고 null — 워커는 계속해서
// 다시 오면 세션 GET에 종합이 실려 있다.
import { fetchWithAuth } from '@/lib/db/client';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';
import { asQueuedJob, waitForBackgroundJob } from '@/lib/background-job';
import type { RetroNextHypothesis, RetroSynthesis } from '@/services/retro-session';

export interface RetroSynthesisResult {
  synthesis: RetroSynthesis;
  next_hypotheses: RetroNextHypothesis[];
}

type SynthesisBody = { synthesis?: RetroSynthesis; next_hypotheses?: RetroNextHypothesis[] };

/** 종합이 만들어졌으면 그 결과, 아니면(요청 실패 · 작업 실패 · 빈 종합 · 화면을 떠남) null. */
export async function requestRetroSynthesis(
  { sessionId, projectId, orgId, signal }: { sessionId: string; projectId: string; orgId: string | undefined; signal?: AbortSignal },
): Promise<RetroSynthesisResult | null> {
  const res = await fetchWithAuth(`/api/retro-sessions/${sessionId}/synthesis?project_id=${projectId}`, {
    timeoutMs: LONG_ROUTES.retroSynthesis.browserMs, method: 'POST',
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: unknown };
  let body = json.data as SynthesisBody | undefined;
  const queued = asQueuedJob(json.data, 'retro_synthesis');
  if (queued) {
    if (!orgId) return null;
    const finished = await waitForBackgroundJob<{ session?: SynthesisBody }>(orgId, queued.id, { signal });
    if (finished?.status !== 'completed') return null;
    body = finished.result?.session;
  }
  if (!body?.synthesis) return null;
  return { synthesis: body.synthesis, next_hypotheses: body.next_hypotheses ?? [] };
}
