// [SID:4680] the plan's agent limit as the recruiter meets it: POST /api/agents answers 402 with the BFF envelope
// `{ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', limit?, tier?, … } }` (ee/plan_limits.check_agent_add_limit — the same 402 the desktop
// setup's «이 조직에서 만들 수 있는 에이전트 수를 넘어요» screen reads). Only this one answer is the limit: any other status or body is an ordinary failure.
export interface AgentLimit {
  /** the limit the server says (`error.limit`, a whole number 0…9999) — null when the answer carries none or a value not fit to print: no number is made up */
  limit: number | null;
  /** tier free or not named (Yuna §K/§N: «free이거나 없을 때») — any other named tier is paid */
  free: boolean;
}

/** a number shown to a person is a plain small one: 0…9999 whole numbers only (a huge or odd value is not printed — the number-less line is) */
export const MAX_SHOWN_LIMIT = 9999;

export function agentLimitOf(status: number, body: unknown): AgentLimit | null {
  if (status !== 402 || !body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, resource, limit, tier } = error as { code?: unknown; resource?: unknown; limit?: unknown; tier?: unknown };
  if (code !== 'PLAN_LIMIT_EXCEEDED' || resource !== 'agent') return null;
  return {
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= MAX_SHOWN_LIMIT ? limit : null,
    free: typeof tier !== 'string' || tier === '' || tier === 'free',
  };
}
