import { describe, expect, it } from 'vitest';
import {
  activeSetupId, forgetActiveSetup, isGuideLink, rememberActiveSetup, ACTIVE_SETUP_TTL_MS,
  agentRowCount, confirmBody, defaultWorkdirHint, needsAnAgent, parseSetupQuery, setupRoleRows, workdirInputOk,
  setupProgress, listableRecipe, hasSetupFragment, type SetupRecipe, type SetupStatus,
} from './desktop-setup';

const CODE = 'A'.repeat(20) + '_-' + 'b'.repeat(21); // 43
const q = (s: string) => new URLSearchParams(s);

// the server's rows (4831 · flow order): 조사(agent) · 작성(either) · 연출(human). Channel stages never come as rows.
const recipe: SetupRecipe = {
  id: 'rec-1',
  key: 'org.marketing_loop',
  name: '마케팅 루프',
  roles: [
    { role: '조사', kind: 'agent', stages: ['research'] },
    { role: '작성', kind: 'either', stages: ['draft'] },
    { role: '연출', kind: 'human', stages: ['review'] },
  ],
};

describe('[SID:4427] desktop setup page rules', () => {
  it('reads the code and the runtimes the app found (fixed order, unknown dropped); no/bad code → null', () => {
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=codex,claude,gemini,codex&setup=7c0e1a2b-0000-4000-8000-000000000001`))).toEqual({ code: CODE, runtimes: ['claude', 'codex'], setupId: '7c0e1a2b-0000-4000-8000-000000000001', blocked: [] });
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=`))).toEqual({ code: CODE, runtimes: [], setupId: null, blocked: [] });
    expect(parseSetupQuery(q(`code=${CODE}&setup=../x`))).toEqual({ code: CODE, runtimes: [], setupId: null, blocked: [] });
    // blocked = found AND blocked only (an id that was not found is dropped)
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=claude,codex&blocked=claude,gemini`))!.blocked).toEqual(['claude']);
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=codex&blocked=claude`))!.blocked).toEqual([]);
    for (const bad of ['', 'code=', `code=${CODE}x`, `code=${CODE.slice(1)}`, `code=${CODE.slice(1)}%2F`]) expect(parseSetupQuery(q(bad)), bad).toBeNull();
  });

  it('the server\'s rows as they come, people first (orderedRecipeRoles order · Yuna 12:49Z); defaults: human → me · agent/either → first runtime', () => {
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

  it('a role the server sends is a row even when its only stage is an approval (loop_agency — the web used to drop it → roles_invalid)', () => {
    const loop: SetupRecipe = { id: 'l', key: 'preset.loop_agency', name: 'loop', roles: [
      { role: 'Planner', kind: 'agent', stages: ['plan'] },
      { role: 'Reviewer', kind: 'either', stages: ['approve'] },
    ] };
    const rows = setupRoleRows(loop, ['claude']);
    expect(rows.map((r) => r.role)).toEqual(['Planner', 'Reviewer']);
    expect(confirmBody(CODE, rows, 'p', 'l', '~/x').roles).toEqual([{ role: 'Planner', runtime: 'claude' }, { role: 'Reviewer', runtime: 'claude' }]);
  });

  it('one agent per ROLE even when the role spans several stages (PO 08:31Z · 4825 CHANGES)', () => {
    const video: SetupRecipe = { id: 'v', key: 'preset.marketing.video_production', name: 'video', roles: [
      { role: 'Director', kind: 'human', stages: ['brief'] },
      { role: 'Creator', kind: 'agent', stages: ['draft', 'editing', 'animatic', 'verification'] },
    ] };
    const rows = setupRoleRows(video, ['claude']);
    expect(rows.map((r) => [r.role, r.stages.length])).toEqual([['Director', 1], ['Creator', 4]]);
    expect(confirmBody(CODE, rows, 'p', 'v', '~/x').roles).toEqual([{ role: 'Creator', runtime: 'claude' }]);
  });

  it('confirm carries {role, runtime} for agent rows and {role, owner: me} for an either row set to «나»; human-only rows are not sent (the BE binds them to whoever pressed «시작» · PO 05:21Z ⒜)', () => {
    const rows = setupRoleRows(recipe, ['claude', 'codex']);
    const draft = rows.find((r) => r.role === '작성')!;
    draft.owner = { kind: 'agent', runtime: 'codex' };
    expect(confirmBody(CODE, rows, 'p-1', 'rec-1', ' ~/Sprintable/마케팅 루프 ')).toEqual({
      code: CODE,
      project_id: 'p-1', recipe_id: 'rec-1',
      roles: [{ role: '조사', runtime: 'claude' }, { role: '작성', runtime: 'codex' }],
      workdir_hint: '~/Sprintable/마케팅 루프',
    });
    draft.owner = { kind: 'me' };
    expect(confirmBody(CODE, rows, 'p', 'r', '~/x').roles).toEqual([{ role: '조사', runtime: 'claude' }, { role: '작성', owner: 'me' }]);
    expect(confirmBody(CODE, rows, 'p', 'r', '~/x').roles.some((x) => x.role === '연출')).toBe(false); // the human row
    expect(agentRowCount(rows)).toBe(1);
  });

  it('no row bound to an agent → cannot start: nothing found, or every either row set to «나» (the BE says no_agent_role)', () => {
    expect(needsAnAgent(setupRoleRows(recipe, []))).toBe(true);
    const found = setupRoleRows(recipe, ['claude']);
    expect(needsAnAgent(found)).toBe(false);
    const eitherOnly: SetupRecipe = { ...recipe, roles: [{ role: '작성', kind: 'either', stages: ['draft'] }] };
    const rows = setupRoleRows(eitherOnly, ['claude']);
    expect(needsAnAgent(rows)).toBe(false);
    rows[0]!.owner = { kind: 'me' };
    expect(needsAnAgent(rows)).toBe(true);
    // a people-only recipe has nothing to start here (it is never listed — listableRecipe)
    const peopleOnly: SetupRecipe = { ...recipe, roles: [{ role: '연출', kind: 'human', stages: ['review'] }] };
    expect(needsAnAgent(setupRoleRows(peopleOnly, []))).toBe(true);
  });

  it('working folder: the default from the recipe name; empty / «~» blocked before «시작» (the app decides the rest)', () => {
    expect(defaultWorkdirHint('마케팅 루프')).toBe('~/Sprintable/마케팅 루프');
    expect(defaultWorkdirHint('a/b')).toBe('~/Sprintable/a b');
    expect(defaultWorkdirHint('..')).toBe('~/Sprintable');
    for (const bad of ['', '  ', '~', '~/', '/']) expect(workdirInputOk(bad), bad).toBe(false);
    for (const ok of ['~/a', '/Users/me/work']) expect(workdirInputOk(ok), ok).toBe(true);
  });
});

describe('[SID:4427] 4426 signal from the web (doc_opened)', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

  it('doc_opened: the setup counts for 30 minutes in this tab', () => {
    const st = mem();
    expect(activeSetupId(0, st)).toBeNull();
    rememberActiveSetup('s1', 1000, st);
    expect(activeSetupId(1000 + ACTIVE_SETUP_TTL_MS, st)).toBe('s1');
    expect(activeSetupId(1001 + ACTIVE_SETUP_TTL_MS, st)).toBeNull();
    rememberActiveSetup('s1', 2000, st);
    forgetActiveSetup(st);
    expect(activeSetupId(2001, st)).toBeNull();
  });

  it('guide links: sprintable.ai writing and the app\'s guides count; work documents and other sites do not', () => {
    const app = 'https://dev-app.sprintable.ai';
    for (const yes of ['https://sprintable.ai/ko/blog/desktop', 'https://docs.sprintable.ai/', 'https://www.sprintable.ai/guide/x', '/llms', '/llms.txt', '/connect-guide.txt', '/help'])
      expect(isGuideLink(yes, app), yes).toBe(true);
    for (const no of ['/docs/7c0e1a2b', '/kanban', 'https://sprintable.ai/', 'https://sprintable.ai/pricing', 'https://example.com/blog/x', 'mailto:a@b.c', 'javascript:alert(1)'])
      expect(isGuideLink(no, app), no).toBe(false);
  });
});

describe('[SID:4427] 진행 표시 — 상태 조회 한 번을 세 단계로(PO 12:25Z 규칙)', () => {
  const base = (): SetupStatus => ({
    state: 'waiting_for_app', recipe_name: '마케팅 루프', work_item_id: 'story-1',
    members: [
      { stage: 'research', role: '조사', member_id: 'm1', kind: 'agent', runtime: 'claude' },
      { stage: 'research_review', role: '조사', member_id: 'm1', kind: 'agent', runtime: 'claude' },
      { stage: 'draft', role: '작성', member_id: 'm2', kind: 'agent', runtime: 'codex' },
      { stage: 'direction', role: '연출', member_id: 'h1', kind: 'human', runtime: null },
    ],
    signals: { tools_connected: [], first_task_handed_at: null, first_result_at: null, workdir_fallback_at: null, blocked: null },
  });
  const T0 = Date.parse('2026-09-30T00:00:00Z');

  it('앱이 받기 전: 모두 도는 중 · 안내 없음 · ⑦ 없음', () => {
    const p = setupProgress(base(), T0, null);
    expect([p.ready, p.handed, p.result]).toEqual(['running', 'running', 'running']);
    expect(p.trustHint).toBe(false);
    expect(p.notConnected).toBe(false);
    expect(p.pairs).toEqual([{ role: '조사', runtime: 'claude' }, { role: '작성', runtime: 'codex' }]); // 역할마다 한 번 · 사람 빠짐
    expect(p.firstAgentRole).toBe('조사');
  });

  it('받았고 연결이 하나만: ① 도는 중 · 신뢰 안내 보임 · 179초까진 ⑦ 아님 · 180초에 ⑦(안내는 ⑦로 바뀜)', () => {
    const s = { ...base(), state: 'handed_over' as const };
    s.signals = { ...s.signals, tools_connected: [{ member_id: 'm1', at: '2026-09-30T00:00:01Z' }] };
    expect(setupProgress(s, T0 + 179_999, T0)).toMatchObject({ ready: 'running', trustHint: true, notConnected: false });
    expect(setupProgress(s, T0 + 180_000, T0)).toMatchObject({ ready: 'running', trustHint: false, notConnected: true });
  });

  it('사람이 입력한 뒤 30초면 ⑦(180초 전이라도) · 29초면 아직', () => {
    const s = { ...base(), state: 'handed_over' as const };
    s.signals = { ...s.signals, first_screen_human_input_at: new Date(T0 + 10_000).toISOString() };
    expect(setupProgress(s, T0 + 39_999, T0).notConnected).toBe(false);
    expect(setupProgress(s, T0 + 40_000, T0).notConnected).toBe(true);
  });

  it('에이전트마다 연결이 오면 ① 끝 · 안내 사라짐 · ⑦ 없음(시간이 지나도)', () => {
    const s = { ...base(), state: 'handed_over' as const };
    s.signals = { ...s.signals, tools_connected: [{ member_id: 'm1', at: 'x' }, { member_id: 'm2', at: 'x' }] };
    expect(setupProgress(s, T0 + 600_000, T0)).toMatchObject({ ready: 'done', trustHint: false, notConnected: false });
  });

  it('② = 건넴 또는 결과 · ③ = 결과', () => {
    const s = { ...base(), state: 'handed_over' as const };
    s.signals = { ...s.signals, first_task_handed_at: 'x' };
    expect(setupProgress(s, T0, T0)).toMatchObject({ handed: 'done', result: 'running' });
    s.signals = { ...s.signals, first_task_handed_at: null, first_result_at: 'y' };
    expect(setupProgress(s, T0, T0)).toMatchObject({ handed: 'done', result: 'done' });
  });

  it('결과가 나온 뒤엔 연결 신호가 비어도 ⑦ 아님(결과가 연결의 증거)', () => {
    const s = { ...base(), state: 'handed_over' as const };
    s.signals = { ...s.signals, first_result_at: 'y' };
    expect(setupProgress(s, T0 + 600_000, T0).notConnected).toBe(false);
  });

  it('폴더 대체 · 막힘(⑥) · 코드 먼저 끝남(④)', () => {
    const s = base();
    s.signals = { ...s.signals, workdir_fallback_at: 'x', blocked: { at: 'x', reason: 'managed_mcp' } };
    expect(setupProgress(s, T0, null)).toMatchObject({ workdirFallback: true, blocked: true, expired: false });
    expect(setupProgress({ ...base(), state: 'not_handed_over' }, T0, null).expired).toBe(true);
  });
});

describe('[SID:4427] what the setup page lists and strips (dev 실측 15:31Z · 4831)', () => {
  it('the server sends only startable recipes; the page still never shows a key as a name nor a people-only card (display guard)', () => {
    expect(listableRecipe(recipe, '마케팅 루프')).toBe(true);
    expect(listableRecipe(recipe, 'org.marketing_loop')).toBe(false); // the key shown as a name
    expect(listableRecipe(recipe, '  ')).toBe(false);
    expect(listableRecipe({ ...recipe, roles: [{ role: '연출', kind: 'human', stages: ['review'] }] }, '연출만')).toBe(false);
    expect(listableRecipe({ ...recipe, roles: [{ role: '작성', kind: 'either', stages: ['draft'] }] }, '작성')).toBe(true);
  });
  it('only a # that carries setup values is stripped', () => {
    expect(hasSetupFragment('#code=abc&setup=s')).toBe(true);
    expect(hasSetupFragment('#setup=s&code=abc')).toBe(true);
    expect(hasSetupFragment('#section-2')).toBe(false);
    expect(hasSetupFragment('#decode=x')).toBe(false);
    expect(hasSetupFragment('')).toBe(false);
  });
});
