import { describe, expect, it } from 'vitest';
import {
  agentRowCount, confirmBody, defaultWorkdirHint, needsAnAgent, parseSetupQuery, setupRoleRows, workdirInputOk,
  type SetupRecipe,
} from './desktop-setup';

const CODE = 'A'.repeat(20) + '_-' + 'b'.repeat(21); // 43
const q = (s: string) => new URLSearchParams(s);

// 조사(agent) · 작성(either) · 연출(human, 게이트) · 발행(채널 연결)
const recipe: SetupRecipe = {
  id: 'rec-1',
  key: 'org.marketing_loop',
  org_id: 'o-1',
  name: '마케팅 루프',
  payload_schema: { properties: { stage: { enum: ['research', 'draft', 'review', 'publish'] } } },
  stage_metadata: {
    research: { role: '조사' },
    draft: { role: '작성' },
    review: { role: '연출', gate: { type: 'approval', approver: 'org_owner' } },
    publish: { role: '발행', capability: { kind: 'publish', target: 'channel_connection' } },
  },
  role_actor_kinds: { 조사: 'agent', 작성: 'either', 연출: 'human' },
};

describe('[SID:4427] desktop setup page rules', () => {
  it('reads the code and the runtimes the app found (fixed order, unknown dropped); no/bad code → null', () => {
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=codex,claude,gemini,codex&setup=7c0e1a2b-0000-4000-8000-000000000001`))).toEqual({ code: CODE, runtimes: ['claude', 'codex'], setupId: '7c0e1a2b-0000-4000-8000-000000000001' });
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=`))).toEqual({ code: CODE, runtimes: [], setupId: null });
    expect(parseSetupQuery(q(`code=${CODE}&setup=../x`))).toEqual({ code: CODE, runtimes: [], setupId: null });
    for (const bad of ['', 'code=', `code=${CODE}x`, `code=${CODE.slice(1)}`, `code=${CODE.slice(1)}%2F`]) expect(parseSetupQuery(q(bad)), bad).toBeNull();
  });

  it('one row per role, opened with defaults: human → me · agent/either → first runtime (Claude Code → Codex) · channel stage has no row', () => {
    const rows = setupRoleRows(recipe, ['claude', 'codex']);
    expect(rows.map((r) => [r.role, r.actor, r.stages, r.owner])).toEqual([
      ['연출', 'human', ['review'], { kind: 'me' }],
      ['조사', 'agent', ['research'], { kind: 'agent', runtime: 'claude' }],
      ['작성', 'either', ['draft'], { kind: 'agent', runtime: 'claude' }],
    ]);
    expect(rows.find((r) => r.role === '연출')!.choices).toEqual([{ kind: 'me' }]);
    expect(rows.find((r) => r.role === '조사')!.choices).toEqual([{ kind: 'agent', runtime: 'claude' }, { kind: 'agent', runtime: 'codex' }]);
    expect(rows.find((r) => r.role === '작성')!.choices.at(-1)).toEqual({ kind: 'me' });
    // only Codex found → Codex is the default
    expect(setupRoleRows(recipe, ['codex']).find((r) => r.role === '조사')!.owner).toEqual({ kind: 'agent', runtime: 'codex' });
  });

  it('a role with no declaration is an agent role (same as the apply window)', () => {
    const rows = setupRoleRows({ ...recipe, role_actor_kinds: null }, ['claude']);
    expect(rows.find((r) => r.role === '조사')!.actor).toBe('agent');
  });

  it('one agent per ROLE even when the role spans several stages (PO 08:31Z · 4825 CHANGES)', () => {
    const video: SetupRecipe = { id: 'v', key: 'preset.marketing.video_production', org_id: null, name: 'video',
      payload_schema: { properties: { stage: { enum: ['brief', 'draft', 'editing', 'animatic', 'verification'] } } },
      stage_metadata: { brief: { role: 'Director', gate: { type: 'approval' } }, draft: { role: 'Creator' }, editing: { role: 'Creator' }, animatic: { role: 'Creator' }, verification: { role: 'Creator' } },
      role_actor_kinds: { Director: 'human', Creator: 'agent' } };
    const rows = setupRoleRows(video, ['claude']);
    expect(rows.map((r) => [r.role, r.stages.length])).toEqual([['Director', 1], ['Creator', 4]]);
    expect(confirmBody(rows, 'p', 'v', '~/x').roles).toEqual([{ role: 'Creator', runtime: 'claude' }]);
  });

  it('confirm carries {role, runtime} for agent rows only; people rows are bound by the BE to whoever pressed «시작»', () => {
    const rows = setupRoleRows(recipe, ['claude', 'codex']);
    const draft = rows.find((r) => r.role === '작성')!;
    draft.owner = { kind: 'agent', runtime: 'codex' };
    expect(confirmBody(rows, 'p-1', 'rec-1', ' ~/Sprintable/마케팅 루프 ')).toEqual({
      project_id: 'p-1', recipe_id: 'rec-1',
      roles: [{ role: '조사', runtime: 'claude' }, { role: '작성', runtime: 'codex' }],
      workdir_hint: '~/Sprintable/마케팅 루프',
    });
    draft.owner = { kind: 'me' };
    expect(confirmBody(rows, 'p', 'r', '~/x').roles).toEqual([{ role: '조사', runtime: 'claude' }]);
    expect(agentRowCount(rows)).toBe(1);
  });

  it('nothing found: an agent-only role cannot start (failure ①); a recipe with only people roles can', () => {
    expect(needsAnAgent(setupRoleRows(recipe, []), [])).toBe(true);
    expect(needsAnAgent(setupRoleRows(recipe, ['claude']), ['claude'])).toBe(false);
    const peopleOnly: SetupRecipe = { ...recipe, stage_metadata: { review: { role: '연출', gate: { type: 'approval' } } }, role_actor_kinds: { 연출: 'human' } };
    expect(needsAnAgent(setupRoleRows(peopleOnly, []), [])).toBe(false);
  });

  it('working folder: the default from the recipe name; empty / «~» blocked before «시작» (the app decides the rest)', () => {
    expect(defaultWorkdirHint('마케팅 루프')).toBe('~/Sprintable/마케팅 루프');
    expect(defaultWorkdirHint('a/b')).toBe('~/Sprintable/a b');
    expect(defaultWorkdirHint('..')).toBe('~/Sprintable');
    for (const bad of ['', '  ', '~', '~/', '/']) expect(workdirInputOk(bad), bad).toBe(false);
    for (const ok of ['~/a', '/Users/me/work']) expect(workdirInputOk(ok), ok).toBe(true);
  });
});
