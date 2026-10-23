// story 4703 — why the recruiter's agent (`agent=`) cannot take a row, from the server's list + the runtimes the app found. Pure.
import { describe, expect, it } from 'vitest';
import { preselectHoldOf, type AttachableAgent } from './desktop-setup';

const A = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'; // an agent of another organization — never in this organization's list
const NOBODY = '33333333-3333-4333-8333-333333333333'; // an id that does not exist anywhere
const agent = (over: Partial<AttachableAgent> = {}): AttachableAgent => ({ id: A, name: 'Hired', runtime: 'claude', live_keys: 0, last_used_at: null, in_project: true, ...over });

describe('[4703] preselectHoldOf — the reason comes from the list and the found runtimes', () => {
  it('no preselect → nothing to say (the road without `agent=` is untouched)', () => {
    expect(preselectHoldOf([agent()], null, ['claude'])).toBeNull();
    expect(preselectHoldOf([agent()], undefined, ['claude'])).toBeNull();
    expect(preselectHoldOf([], '', ['claude'])).toBeNull();
  });

  it('in the project and its runtime usable here → it lands: nothing to say', () => {
    expect(preselectHoldOf([agent()], A, ['claude', 'codex'])).toBeNull();
  });

  it('not in the list → `unlisted`, carrying NO name or id', () => {
    const hold = preselectHoldOf([agent({ id: 'someone-else' })], A, ['claude']);
    expect(hold).toEqual({ reason: 'unlisted' });
    expect(Object.keys(hold ?? {})).toEqual(['reason']);
  });

  it('another organization\'s agent and an id that exists nowhere are ONE answer (nothing about «exists elsewhere» shows)', () => {
    const list = [agent({ id: 'a-member-of-this-org' })];
    const foreign = preselectHoldOf(list, OTHER_ORG, ['claude']);
    const nobody = preselectHoldOf(list, NOBODY, ['claude']);
    expect(foreign).toEqual(nobody);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(nobody));
    expect(preselectHoldOf([], OTHER_ORG, ['claude'])).toEqual(preselectHoldOf([], NOBODY, ['claude']));
  });

  it('in the list but outside the project (its runtime usable) → `outside_project` with the agent (an in-organization fact)', () => {
    const a = agent({ in_project: false });
    expect(preselectHoldOf([a], A, ['claude'])).toEqual({ reason: 'outside_project', agent: a });
  });

  it('its runtime is not on this computer → `runtime_missing`', () => {
    const a = agent({ runtime: 'codex' });
    expect(preselectHoldOf([a], A, ['claude'])).toEqual({ reason: 'runtime_missing', agent: a });
    expect(preselectHoldOf([a], A, [])).toEqual({ reason: 'runtime_missing', agent: a });
  });

  it('its runtime is found but blocked (company-managed) → `runtime_blocked`, not «missing»', () => {
    const a = agent({ runtime: 'claude' });
    // the page's `runtimes` leave the blocked ones out
    expect(preselectHoldOf([a], A, ['codex'], ['claude'])).toEqual({ reason: 'runtime_blocked', agent: a });
  });

  it('several reasons together: the runtime first (adding it to the project would not make it run)', () => {
    const missing = agent({ runtime: 'codex', in_project: false });
    expect(preselectHoldOf([missing], A, ['claude'])?.reason).toBe('runtime_missing');
    const blocked = agent({ runtime: 'claude', in_project: false });
    expect(preselectHoldOf([blocked], A, ['codex'], ['claude'])?.reason).toBe('runtime_blocked');
  });

  it('agrees with the rule the page lands a preselect by (in the project · its runtime usable) for EVERY combination', () => {
    // the component's `preselectLands`: list.some((a) => a.id === preselect && a.in_project && runtimes.includes(a.runtime))
    for (const listed of [false, true]) for (const inProject of [false, true]) for (const runtime of ['claude', 'codex'] as const) {
      for (const usable of [[], ['claude'], ['codex'], ['claude', 'codex']] as const) {
        for (const blocked of [[], ['claude']] as const) {
          const usableNow = usable.filter((r) => !(blocked as readonly string[]).includes(r));
          const list = listed ? [agent({ in_project: inProject, runtime })] : [];
          const lands = list.some((a) => a.id === A && a.in_project && usableNow.includes(a.runtime));
          expect(preselectHoldOf(list, A, usableNow, blocked) === null, JSON.stringify({ listed, inProject, runtime, usableNow, blocked })).toBe(lands);
        }
      }
    }
  });
});
