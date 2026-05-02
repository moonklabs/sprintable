
import type { SupabaseClient } from '@/types/supabase';
import { AgentExecutionLoop } from './agent-execution-loop';
import type { SessionResumeCandidate } from './agent-session-lifecycle';

export async function resumeSessionCandidates(
  db: SupabaseClient,
  candidates: SessionResumeCandidate[],
) {
  const loop = new AgentExecutionLoop(db);

  for (const candidate of candidates) {
    try {
      await loop.execute({
        runId: candidate.runId,
        memoId: candidate.memoId,
        orgId: candidate.orgId,
        projectId: candidate.projectId,
        agentId: candidate.agentId,
        triggerEvent: 'agent_session.resumed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session_resume_failed';
      await db
        .from('agent_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          last_error_code: 'session_resume_failed',
          error_message: message,
          result_summary: 'Queued run failed while resuming after session capacity was freed',
        })
        .eq('id', candidate.runId);
    }
  }
}
