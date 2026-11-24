// story 5009 (A2 · AC5) — an app from before a runtime existed, opening a page of a server that offers it: pure rules (no component).
import { describe, expect, it } from 'vitest';
import { appCannotDrive, moveRowBlocked, parseSetupQuery, preselectHoldOf, setupFragment, type AttachableAgent } from './desktop-setup';

const A = '11111111-1111-4111-8111-111111111111';
const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const oc = (over: Partial<AttachableAgent> = {}): AttachableAgent => ({ id: A, name: 'OC', runtime: 'opencode', live_keys: 0, last_used_at: null, in_project: true, needs_capability: 'rt-opencode', ...over });

describe('[SID:5009] the app\'s runtime words', () => {
  it('a word the app did not say makes the agent «outdated»; claude · codex (no word needed) never are', () => {
    expect(appCannotDrive(oc(), [])).toBe(true);
    expect(appCannotDrive(oc(), ['rt-gemini'])).toBe(true);
    expect(appCannotDrive(oc(), ['rt-opencode'])).toBe(false);
    expect(appCannotDrive(oc({ needs_capability: null }), [])).toBe(false);
    expect(appCannotDrive({}, [])).toBe(false); // an older server sends no field: as before
    expect(moveRowBlocked('app-outdated')).toBe(true);
    expect(moveRowBlocked('runtime-missing')).toBe(true);
    expect(moveRowBlocked('ok')).toBe(false);
  });

  it('the recruiter\'s agent (`agent=`) of such a runtime, for an app from before: the hold says «outdated» — before «not on this computer» and before «outside the project»', () => {
    expect(preselectHoldOf([oc()], A, ['claude'], [], [])).toEqual({ reason: 'app_outdated', agent: oc() });
    expect(preselectHoldOf([oc({ in_project: false })], A, ['claude'], [], [])).toMatchObject({ reason: 'app_outdated' });
    expect(preselectHoldOf([oc()], A, ['claude'], [], ['rt-opencode'])).toMatchObject({ reason: 'runtime_missing' }); // the app can; the program is not found here: the old line
    expect(preselectHoldOf([oc()], A, ['claude', 'opencode'], [], ['rt-opencode'])).toBeNull();
    expect(preselectHoldOf([oc()], 'nobody-here', ['claude'], [], [])).toEqual({ reason: 'unlisted' });
  });

  it('the page reads the words from `caps=` (closed shape · at most 8) and keeps them in the address it writes back; an app from before has none', () => {
    const q = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,opencode&caps=move,solo,rt-opencode,workdir,not a word,RT-X,rt-`));
    expect(q?.appRuntimeWords).toEqual(['rt-opencode']);
    expect(parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude&caps=move,solo`))?.appRuntimeWords).toBeUndefined();
    const back = setupFragment({ ...q!, canSolo: true, canMove: true });
    expect(new URLSearchParams(back.replace(/^#/, '')).get('caps')).toContain('rt-opencode');
  });
});
