/** story 5008 (A1) — the web's one runtime module: the lists the web used to spell out in six files are this module's, and a name this build does not know is data, never an error. */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_RUNTIME_IDS,
  ENABLED_DESKTOP_RUNTIME_IDS,
  ENABLED_MEMBER_RUNTIME_TYPES,
  MEMBER_RUNTIME_TYPE,
  isEnabledRuntimeId,
} from './desktop-runtimes';
import { DESKTOP_RUNTIMES as SETUP_RUNTIMES } from './desktop-setup';
import { DESKTOP_RUNTIMES_IN_APP } from './desktop-app';
import { DESKTOP_RUNTIMES as MEMBER_TYPES } from './agent-run-profile';

describe('desktop runtimes — one module', () => {
  it('the app is offered claude, codex and opencode, in that order (first is the default) — OpenCode switched on in story 5009 (A2)', () => {
    expect([...ENABLED_DESKTOP_RUNTIME_IDS]).toEqual(['claude', 'codex', 'opencode']);
    expect([...ENABLED_MEMBER_RUNTIME_TYPES]).toEqual(['claude-code', 'codex', 'opencode']);
    expect(MEMBER_RUNTIME_TYPE).toEqual({ claude: 'claude-code', codex: 'codex', opencode: 'opencode' });
  });

  it('every enabled id is one of the names the server allows in its tables', () => {
    for (const id of ENABLED_DESKTOP_RUNTIME_IDS) expect(DESKTOP_RUNTIME_IDS as readonly string[]).toContain(id);
  });

  it('the lists the web files used to spell out are this module\'s lists', () => {
    expect(SETUP_RUNTIMES).toBe(ENABLED_DESKTOP_RUNTIME_IDS);
    expect(DESKTOP_RUNTIMES_IN_APP).toBe(ENABLED_DESKTOP_RUNTIME_IDS);
    expect([...MEMBER_TYPES]).toEqual([...ENABLED_MEMBER_RUNTIME_TYPES]);
  });

  it('a name that came over the wire is acted on only when it is enabled; anything else (a newer runtime, a number, nothing) is just not acted on', () => {
    expect(isEnabledRuntimeId('claude')).toBe(true);
    expect(isEnabledRuntimeId('codex')).toBe(true);
    expect(isEnabledRuntimeId('opencode')).toBe(true);
    for (const v of ['gemini', 'cursor', 'a-future-agent', '', 7, null, undefined, ['claude']]) expect(isEnabledRuntimeId(v)).toBe(false);
  });
});
