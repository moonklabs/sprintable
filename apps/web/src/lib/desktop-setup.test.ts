import { describe, expect, it } from 'vitest';
import {
  activeSetupId, isGuideLink, rememberActiveSetup, ACTIVE_SETUP_TTL_MS,
  agentRowCount, confirmBody, defaultWorkdirHint, needsAnAgent, parseSetupQuery, setupRoleRows, workdirInputOk,
  setupProgress, type SetupRecipe, type SetupStatus,
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
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=codex,claude,gemini,codex&setup=7c0e1a2b-0000-4000-8000-000000000001`))).toEqual({ code: CODE, runtimes: ['claude', 'codex'], setupId: '7c0e1a2b-0000-4000-8000-000000000001', blocked: [] });
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=`))).toEqual({ code: CODE, runtimes: [], setupId: null, blocked: [] });
    expect(parseSetupQuery(q(`code=${CODE}&setup=../x`))).toEqual({ code: CODE, runtimes: [], setupId: null, blocked: [] });
    // blocked = found AND blocked only (an id that was not found is dropped)
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=claude,codex&blocked=claude,gemini`))!.blocked).toEqual(['claude']);
    expect(parseSetupQuery(q(`code=${CODE}&runtimes=codex&blocked=claude`))!.blocked).toEqual([]);
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
    expect(confirmBody(CODE, rows, 'p', 'v', '~/x').roles).toEqual([{ role: 'Creator', runtime: 'claude' }]);
  });

  it('confirm carries {role, runtime} for agent rows only; people rows are bound by the BE to whoever pressed «시작»', () => {
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
    expect(confirmBody(CODE, rows, 'p', 'r', '~/x').roles).toEqual([{ role: '조사', runtime: 'claude' }]);
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

describe('[SID:4427] 4426 signal from the web (doc_opened)', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

  it('doc_opened: the setup counts for 30 minutes in this tab', () => {
    const st = mem();
    expect(activeSetupId(0, st)).toBeNull();
    rememberActiveSetup('s1', 1000, st);
    expect(activeSetupId(1000 + ACTIVE_SETUP_TTL_MS, st)).toBe('s1');
    expect(activeSetupId(1001 + ACTIVE_SETUP_TTL_MS, st)).toBeNull();
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
