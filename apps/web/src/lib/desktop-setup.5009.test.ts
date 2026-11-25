// story 5009 (A2 · AC5) — an app from before a runtime existed, opening a page of a server that offers it: pure rules (no component).
import { describe, expect, it } from 'vitest';
import { appCannotDrive, moveAfterTools, moveRowBlocked, parseSetupFragment, parseSetupQuery, preselectHoldOf, setupFragment, type AttachableAgent } from './desktop-setup';
import { RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';

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

  it('a runtime the app reports but whose word it did not say is dropped once, at the address: not a recipe choice, not a solo default (an old or odd app)', () => {
    const without = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,opencode&caps=move,solo`))!;
    expect(without.runtimes).toEqual(['claude']);
    const withWord = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,opencode&caps=move,solo,rt-opencode`))!;
    expect(withWord.runtimes).toEqual(['claude', 'opencode']);
    // another runtime's word does not open it; claude · codex need none
    expect(parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,codex,opencode&caps=rt-gemini`))!.runtimes).toEqual(['claude', 'codex']);
  });

  it('the page reads the words from `caps=` (closed shape · at most 8) and keeps them in the address it writes back; an app from before has none', () => {
    const q = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,opencode&caps=move,solo,rt-opencode,workdir,not a word,RT-X,rt-`));
    expect(q?.appRuntimeWords).toEqual(['rt-opencode']);
    expect(parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude&caps=move,solo`))?.appRuntimeWords).toBeUndefined();
    const back = setupFragment({ ...q!, canSolo: true, canMove: true });
    expect(new URLSearchParams(back.replace(/^#/, '')).get('caps')).toContain('rt-opencode');
  });

  it('the whole fragment round-trips: what the page writes back is what it reads again (the words, the runtimes, the flags)', () => {
    const q = parseSetupQuery(new URLSearchParams(`code=${CODE}&runtimes=claude,opencode&caps=move,solo,rt-opencode,workdir&setup=s-1`))!;
    const back = parseSetupFragment(setupFragment(q))!;
    expect(back.appRuntimeWords).toEqual(['rt-opencode']);
    expect([back.code, back.runtimes, back.setupId, back.canMove, back.canSolo, back.canWorkdir]).toEqual([q.code, q.runtimes, q.setupId, q.canMove, q.canSolo, q.canWorkdir]);
  });

  it('«sign in to …» after a move never names a runtime that needs no sign-in (an OpenCode-only move says nothing)', () => {
    const list = [oc(), oc({ id: 'b', runtime: 'claude', needs_capability: null })];
    expect(moveAfterTools([oc()], ['opencode'], [], ['rt-opencode'])).toEqual([]);
    expect(moveAfterTools(list, ['claude', 'opencode'], [], ['rt-opencode'])).toEqual(['claude']);
  });

  it('the recruiter\'s capability fallback marks OpenCode as a desktop runtime (the capability API being down must not lose «start here»)', () => {
    expect(RUNTIME_CAPABILITIES_FALLBACK.find((r) => r.slug === 'opencode')?.desktop_runtime).toBe('opencode');
    expect(RUNTIME_CAPABILITIES_FALLBACK.find((r) => r.slug === 'claude-code')?.desktop_runtime).toBe('claude');
  });
});
