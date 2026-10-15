// story 4680 (UX-1 · D2) — the setup address carries `agent=<member id>` (the app's startHere put it there), and that agent takes
// the first agent/either row once it is among the row's «이미 있는 에이전트» choices. Reverted → the field is dropped / no row changes.
import { describe, expect, it } from 'vitest';
import { parseSetupQuery, setupFragment, parseSetupFragment, withPreselectedAgent, withAttachable, setupRoleRows, type AttachableAgent, type SetupRecipe } from './desktop-setup';

const CODE = 'c'.repeat(43);
const q = (s: string) => new URLSearchParams(s);
const DAN = 'a1111111-0000-4000-8000-000000000001';
const OUT = 'a1111111-0000-4000-8000-000000000004';

describe('[SID:4680] agent= in the setup address', () => {
  it('a uuid is kept · anything else is left out of the parsed shape', () => {
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=claude&agent=${DAN}`))!.agent).toBe(DAN);
    for (const bad of ['', 'x', '../x', `${DAN}x`, 'agent-1']) expect('agent' in parseSetupQuery(q(`code=${CODE}&agent=${bad}`))!, bad).toBe(false);
  });

  it('setupFragment carries it and parseSetupFragment reads it back', () => {
    const frag = setupFragment({ code: CODE, runtimes: ['claude'], setupId: null, blocked: [], agent: DAN });
    expect(frag).toContain(`agent=${DAN}`);
    expect(parseSetupFragment(frag)!.agent).toBe(DAN);
  });
});

const recipe: SetupRecipe = {
  id: 'r1', key: 'k', org_id: null, name: 'R', description: null, actors: null,
  roles: [{ role: '조사', kind: 'agent', stages: ['research'] }, { role: '작성', kind: 'either', stages: ['write'] }, { role: '연출', kind: 'human', stages: ['direct'] }],
} as unknown as SetupRecipe;
const agents: AttachableAgent[] = [
  { id: DAN, name: '댄', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: true },
  { id: OUT, name: '바깥', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: false },
];

describe('[SID:4680] withPreselectedAgent', () => {
  const rows = () => withAttachable(setupRoleRows(recipe, ['claude']), agents, ['claude']);

  it('the first agent row takes the agent · later rows stay · a human row is skipped (rows: people first, then the recipe order)', () => {
    const out = withPreselectedAgent(rows(), DAN);
    expect(out.map((r) => r.role)).toEqual(['연출', '조사', '작성']);
    expect(out[0]!.owner.kind).toBe('me'); // the human row is not a candidate
    expect(out[1]!.owner).toEqual({ kind: 'existing', agentId: DAN, name: '댄', runtime: 'claude' }); // reverted → { kind: 'agent' }
    expect(out[2]!.owner.kind).toBe('agent'); // only the first agent row
  });

  it('not among the choices (not on the team · unknown id · nothing asked) → the rows as they were', () => {
    const before = rows();
    expect(withPreselectedAgent(before, OUT)).toEqual(before);
    expect(withPreselectedAgent(before, 'a1111111-0000-4000-8000-000000000099')).toEqual(before);
    expect(withPreselectedAgent(before, null)).toEqual(before);
  });
});
