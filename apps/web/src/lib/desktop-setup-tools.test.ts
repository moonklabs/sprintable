// story 4653 (Yuna ⑤ · PO 15017): the tool names an agent row carries — short lowercase, no repeat, the runtime not again, at most
// eight in all (the runtime counts as one); the confirm body sends the runtime first, then the names the person added.
import { describe, expect, it } from 'vitest';
import { addAgentTool, agentToolNames, confirmBody, hasSignInCheck, type SetupRoleRow } from './desktop-setup';

describe('[4653] adding a tool name to an agent row', () => {
  it('a short lowercase name is added; upper case is lowered; repeats and the runtime are refused', () => {
    expect(addAgentTool([], 'claude', 'AWS')).toEqual({ ok: true, tools: ['aws'] });
    expect(addAgentTool(['aws'], 'claude', 'aws')).toEqual({ ok: false, reason: 'duplicate' });
    expect(addAgentTool([], 'claude', 'claude')).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('a name that is not a short plain word is refused (no space, no path, no leading digit, at most 24)', () => {
    for (const bad of ['a b', '../x', '1aws', '', 'x'.repeat(25), 'aws/x', '  ']) {
      expect(addAgentTool([], 'codex', bad)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('at most eight in all, the runtime counted as one (seven extras)', () => {
    const seven = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    expect(addAgentTool(seven.slice(0, 6), 'claude', 'a7')).toEqual({ ok: true, tools: [...seven.slice(0, 6), 'a7'] });
    expect(addAgentTool(seven, 'claude', 'a8')).toEqual({ ok: false, reason: 'max' });
  });
});

describe('[4653] the sign-in check and the names sent', () => {
  it('the runtime and the judged names have a check; any other name has none', () => {
    expect(hasSignInCheck('claude', 'claude')).toBe(true);
    expect(hasSignInCheck('gcloud', 'claude')).toBe(true);
    expect(hasSignInCheck('aws', 'codex')).toBe(true);
    expect(hasSignInCheck('kubectl', 'codex')).toBe(false);
  });

  it('the runtime comes first and is never repeated among the extras', () => {
    expect(agentToolNames('codex', ['gh', 'codex', 'aws'])).toEqual(['codex', 'gh', 'aws']);
  });

  it('the confirm body sends tools only when the person added names (the runtime alone is the old body), and none for a person row', () => {
    const agentRow = { role: 'pm', actor: 'agent', stages: ['s1'], choices: [], owner: { kind: 'agent', runtime: 'claude' }, tools: ['gcloud'] } as SetupRoleRow;
    const existingRow = { role: 'dev', actor: 'agent', stages: ['s2'], choices: [], owner: { kind: 'existing', agentId: 'a-1', name: 'x', runtime: 'codex' }, tools: [] } as SetupRoleRow;
    const meRow = { role: 'me', actor: 'either', stages: ['s3'], choices: [], owner: { kind: 'me' } } as SetupRoleRow;
    const body = confirmBody('code-code-code-code-1', [agentRow, existingRow, meRow], 'p1', 'r1', '');
    expect(body.roles).toEqual([
      { role: 'pm', runtime: 'claude', tools: ['claude', 'gcloud'] },
      { role: 'dev', agent_id: 'a-1' },
      { role: 'me', owner: 'me' },
    ]);
  });
});
