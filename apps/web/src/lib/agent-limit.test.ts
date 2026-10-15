// [SID:4680] agentLimitOf: only 402 + PLAN_LIMIT_EXCEEDED + resource «agent» is the agent limit; the number and the tier come from the answer, never made up.
import { describe, expect, it } from 'vitest';
import { agentLimitOf } from './agent-limit';

const env = (over: Record<string, unknown> = {}) => ({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent', limit: 3, current: 3, tier: 'free', upgrade_required: true, ...over } });

describe('[4680] the agent limit answer', () => {
  it('402 + PLAN_LIMIT_EXCEEDED + resource agent → the limit and «free»', () => {
    expect(agentLimitOf(402, env())).toEqual({ limit: 3, free: true });
  });
  it('the limit is the server\'s number only: absent · text · fraction · negative → null (no number is made up)', () => {
    for (const limit of [undefined, null, '3', 2.5, -1, NaN, Infinity, {}, []]) expect(agentLimitOf(402, env({ limit }))?.limit ?? null, String(limit)).toBeNull();
    expect(agentLimitOf(402, env({ limit: 0 }))?.limit).toBe(0);
  });
  it('tier: free · empty · not named → free; any other named tier → paid', () => {
    expect(agentLimitOf(402, env({ tier: undefined }))?.free).toBe(true);
    expect(agentLimitOf(402, env({ tier: '' }))?.free).toBe(true);
    expect(agentLimitOf(402, env({ tier: 7 }))?.free).toBe(true);
    for (const tier of ['starter', 'team', 'business']) expect(agentLimitOf(402, env({ tier }))?.free, tier).toBe(false);
  });
  it('another resource (project · org · seat · automation_units) is not the agent limit', () => {
    for (const resource of ['project', 'org', 'seat', 'automation_units', 'Agent', 'agents', '']) expect(agentLimitOf(402, env({ resource })), resource).toBeNull();
  });
  it('another code or another status is not (a 500 · 403 · 429 with the same body stays an ordinary failure)', () => {
    expect(agentLimitOf(402, env({ code: 'AU_PAUSED' }))).toBeNull();
    for (const status of [200, 400, 401, 403, 404, 409, 429, 500, 503]) expect(agentLimitOf(status, env()), String(status)).toBeNull();
  });
  it('a body that is not the envelope is not (null · text · array · no error · error without fields · detail-only)', () => {
    for (const body of [null, undefined, 'x', 7, [], {}, { error: null }, { error: 'PLAN_LIMIT_EXCEEDED' }, { error: {} }, { detail: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent' } }, { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent' }]) {
      expect(agentLimitOf(402, body)).toBeNull();
    }
  });
});
