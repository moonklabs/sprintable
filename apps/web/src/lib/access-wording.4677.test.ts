// story 4677 (UX-1 · P4) AC2 — one thing for «an agent being in a project» (유나 §L ④ ⑤): «프로젝트 팀에 들어가 있어요 / 프로젝트 팀 n곳» (ko) ·
// «On … team» (en). The old words — the «접근 허용 / 접근 차단» counters, «프로젝트에 추가해 주세요», «# project(s) granted» — are gone from
// the messages. The guard reads EVERY string of both message files (not one key): a counter that comes back anywhere turns this RED.
// 유나 §L ⑥ rule: a screen's or tab's NAME «접근 권한» / "Access" stays (the way-finding line must equal the real tab) — what changes is the words
// for going on / off a project's team («허용 · 차단 · 부여 · grant»); and no such toast is hard-coded in a .tsx any more (the settings section's
// four toasts used to be Korean-only «…습니다» strings).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

/** every string value of a messages tree, with its path */
function strings(node: unknown, path: string[] = []): { path: string; value: string }[] {
  if (typeof node === 'string') return [{ path: path.join('.'), value: node }];
  if (node && typeof node === 'object') return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
}
const koStrings = strings(ko);
const enStrings = strings(en);
const hits = (all: { path: string; value: string }[], re: RegExp) => all.filter((s) => re.test(s.value)).map((s) => s.path);

// the shapes the old wording took: «접근 허용/차단», «프로젝트에 추가해 주세요», a count followed by «프로젝트 허용» / «프로젝트 {count}개 접근 허용»
const KO_OLD = [
  /접근\s*허용/, /접근\s*차단/, /프로젝트에 추가해 주세요/, /\{count\}\s*개\s*프로젝트\s*(접근\s*)?(허용|차단)/, /프로젝트\s*\{count\}\s*개\s*(접근\s*)?(허용|차단)/,
  // 유나 §L ⑥: the grid / toasts / scope card / recruiter step spoke of grant · block · 부여 for the team
  /(허용|차단)\s*\/\s*(허용|차단)/, /(허용|차단)됨\s*—\s*클릭/, /클릭해\s*(허용|차단)/, /프로젝트에\s*부여/, /부여\s*프로젝트/, /권한\s*(부여|해제)/, /상시 허용/, /프로젝트\s*접근을\s*허용/,
  /프로젝트에\s*접근하나요/,
  // the tab's NAME is one spelling: «접근 권한» (never «접근권한»)
  /접근권한/,
];
// en: «# project(s) granted», «Allow access», «Block access», «projects allowed/blocked» as a count
const EN_OLD = [
  /#\s*projects?\s+granted/i, /\bAllow access\b/, /\bBlock access\b/, /#\s*projects?\s+(allowed|blocked)/i, /\{count\}\s*projects?\s+(granted|allowed|blocked)/i,
  /toggle grant\/block/i, /(Granted|Blocked)\s*—\s*click/, /click to (grant|block)/i, /Granted to (the|all|every)/, /regardless of how many projects/i,
  /allowed to access this project/i, /projects should the new agent access/i, // («Failed to grant/revoke access» is the inbox's own line — the settings keys are pinned exactly below)
];

describe('[SID:4677] AC2 — the old access words stay out of every message (ko · en)', () => {
  it('ko: no «접근 허용/차단» · «프로젝트에 추가해 주세요» · «{count}개 프로젝트 허용» counters in any string', () => {
    for (const re of KO_OLD) expect(hits(koStrings, re), String(re)).toEqual([]);
  });

  it('en: no «# project(s) granted» · «Allow access» · «Block access» counters in any string', () => {
    for (const re of EN_OLD) expect(hits(enStrings, re), String(re)).toEqual([]);
  });

  it('the guard itself sees the old shapes (a self-check — it is not a guard that matches nothing)', () => {
    expect('프로젝트 3개 접근 허용').toMatch(KO_OLD[0]!);
    expect('{count}개 프로젝트 허용').toMatch(KO_OLD[3]!);
    expect('프로젝트 {count}개 접근 허용').toMatch(KO_OLD[4]!);
    expect('{count, plural, one {# project granted} other {# projects granted}}').toMatch(EN_OLD[0]!);
    expect('Allow access').toMatch(EN_OLD[1]!);
    expect('셀을 눌러 허용/차단을 즉시 토글해요.').toMatch(KO_OLD[5]!);
    expect('접근권한 매트릭스').toMatch(KO_OLD[KO_OLD.length - 1]!);
    expect('Click a cell to toggle grant/block instantly.').toMatch(EN_OLD[5]!);
  });
});

type Translate = (key: string, values?: Record<string, number | string>) => string;
const translator = (locale: 'ko' | 'en', namespace: string): Translate =>
  (createTranslator as unknown as (o: object) => Translate)({ locale, messages: locale === 'ko' ? ko : en, namespace });

describe('[SID:4677] AC2 — the agent card line (connect rules › agents · admin): connectRulesV3.agentAccessGranted', () => {
  it('ko: none → «아직 어느 프로젝트 팀에도 없어요» · n → «프로젝트 팀 n곳에 들어가 있어요»', () => {
    const k = translator('ko', 'connectRulesV3');
    expect(k('agentAccessGranted', { count: 0 })).toBe('아직 어느 프로젝트 팀에도 없어요');
    expect(k('agentAccessGranted', { count: 1 })).toBe('프로젝트 팀 1곳에 들어가 있어요');
    expect(k('agentAccessGranted', { count: 3 })).toBe('프로젝트 팀 3곳에 들어가 있어요');
  });

  it("en: none → «Not on any project's team yet» · 1 → «On 1 project's team» · n → «On n projects' teams»", () => {
    const e = translator('en', 'connectRulesV3');
    expect(e('agentAccessGranted', { count: 0 })).toBe("Not on any project's team yet");
    expect(e('agentAccessGranted', { count: 1 })).toBe("On 1 project's team");
    expect(e('agentAccessGranted', { count: 2 })).toBe("On 2 projects' teams");
  });
});

describe('[SID:4677] AC2 — the workforce chip (agents list): agents.manageProjectsGranted', () => {
  it('ko: none → «프로젝트 팀 없음» · n → «프로젝트 팀 n곳»', () => {
    const k = translator('ko', 'agents');
    expect(k('manageProjectsGranted', { count: 0 })).toBe('프로젝트 팀 없음');
    expect(k('manageProjectsGranted', { count: 1 })).toBe('프로젝트 팀 1곳');
    expect(k('manageProjectsGranted', { count: 4 })).toBe('프로젝트 팀 4곳');
  });

  it('en: none → «No project team» · 1 → «1 project team» · n → «n project teams»', () => {
    const e = translator('en', 'agents');
    expect(e('manageProjectsGranted', { count: 0 })).toBe('No project team');
    expect(e('manageProjectsGranted', { count: 1 })).toBe('1 project team');
    expect(e('manageProjectsGranted', { count: 3 })).toBe('3 project teams');
  });
});

/** every non-test .ts/.tsx under src — for the hard-coded Korean scan */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe('[SID:4677] AC2 — no hard-coded «허용/차단» toast in a source file (the words live in the messages)', () => {
  it('no .ts/.tsx has «접근을 허용/차단했습니다» · «허용/차단에 실패했습니다» as text', () => {
    const root = join(__dirname, '..'); // apps/web/src
    const re = /접근을\s*(허용|차단)|(허용|차단)했습니다|(허용|차단)에\s*실패/;
    const found = sourceFiles(root).filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(found).toEqual([]);
  });
});

describe('[SID:4677] AC2 — the copy of 유나 §L ⑥, key by key (ko · en); the tab names stay', () => {
  const ROWS: [ns: string, key: string, koText: string, enText: string][] = [
    ['settings', 'agentProjectAccessPutOn', '{project} 팀에 넣었어요', 'On the {project} team now'],
    ['settings', 'agentProjectAccessTakeOff', '{project} 팀에서 뺐어요', 'Taken off the {project} team'],
    ['settings', 'agentProjectAccessPutOnFailed', '{project} 팀에 넣지 못했어요 — 다시 눌러 주세요', "Couldn't put it on the {project} team — try again"],
    ['settings', 'agentProjectAccessTakeOffFailed', '{project} 팀에서 빼지 못했어요 — 다시 눌러 주세요', "Couldn't take it off the {project} team — try again"],
    // 유나 정정(10-14): the server covers the projects there are NOW only (scope_mode='org' · no auto-grant for later ones) — the line must not promise more
    ['settings', 'agentScopeAllProjectsBody', '이 조직에 지금 있는 모든 프로젝트 팀에 들어가요.', 'Joins every project team this organization has now.'],
    ['settings', 'agentScopeSpecificProjectsBody', '고른 프로젝트 팀에만 들어가요.', 'Joins only the project teams you pick.'],
    ['settings', 'agentSeatCaption', '들어간 프로젝트 팀이 몇 곳이든 이 에이전트는 좌석 1개로 세요.', "This agent counts as one seat however many project teams it's on."],
    ['settings', 'projectAccessSubtitle', '이 프로젝트 팀에 들어갈 조직 구성원을 골라요.', "Choose which organization members are on this project's team."],
    ['settings', 'projectAccessGrantFailed', '팀에 넣지 못했어요', "Couldn't put on the team"],
    ['settings', 'projectAccessRevokeFailed', '팀에서 빼지 못했어요', "Couldn't take off the team"],
    ['settings', 'projectAccessAlwaysAllowed', '늘 들어감', 'Always on the team'],
    ['agents', 'accessTab', '접근 권한', 'Access'],
    ['agents', 'matrixTitle', '접근 권한 매트릭스', 'Access matrix'],
    ['agents', 'matrixDescription', '칸을 누르면 그 프로젝트 팀에 넣거나 빼요.', "Click a cell to put the agent on or take it off that project's team."],
    ['agents', 'matrixGrantedCount', '팀에 들어감', 'on a team'],
    ['agents', 'matrixCellGranted', '들어감 — 눌러서 빼기', 'On the team — click to take off'],
    ['agents', 'matrixCellBlocked', '안 들어감 — 눌러서 넣기', 'Not on the team — click to put on'],
    ['agents', 'matrixLegendGranted', '들어감', 'On the team'],
    ['agents', 'matrixLegendBlocked', '안 들어감', 'Not on the team'],
    ['recruiter', 'scopeQuestion', '새 에이전트를 어느 프로젝트 팀에 넣을까요?', 'Which project teams should the new agent join?'],
    ['recruiter', 'scopeStepGuide', '만든 뒤에도 접근 권한 탭에서 바꿀 수 있어요.', 'You can change this later in the Access tab.'],
  ];
  const at = (tree: unknown, ns: string, key: string) => ((tree as Record<string, Record<string, string>>)[ns] ?? {})[key];

  it.each(ROWS)('%s.%s', (ns, key, koText, enText) => {
    expect(at(ko, ns, key)).toBe(koText);
    expect(at(en, ns, key)).toBe(enText);
  });

  it('the plural lines: «전체 n개 프로젝트에 부여돼요» is «프로젝트 팀 n곳 모두에 들어가요» (1 → «하나뿐인 프로젝트 팀에 들어가요» — ko has only «other», so the single case is =1)', () => {
    const k = translator('ko', 'settings');
    const e = translator('en', 'settings');
    expect(k('agentScopeAllProjectsHint', { count: 1 })).toBe('하나뿐인 프로젝트 팀에 들어가요.');
    expect(k('agentScopeAllProjectsHint', { count: 4 })).toBe('프로젝트 팀 4곳 모두에 들어가요.');
    expect(e('agentScopeAllProjectsHint', { count: 1 })).toBe('Joins the only project team.');
    expect(e('agentScopeAllProjectsHint', { count: 3 })).toBe('Joins all 3 project teams.');
  });

  it('the tab names are left alone: the way-finding lines still say «프로젝트 설정 › 접근 권한» / "Access" (the real tab)', () => {
    const byKey = (all: { path: string; value: string }[], key: string) => all.filter((x) => x.path.endsWith(`.${key}`)).map((x) => x.value);
    for (const v of byKey(koStrings, 'switcherAccessLoadError')) expect(v).toContain('프로젝트 설정 › 접근 권한');
    for (const v of byKey(koStrings, 'switcherAccessPartial')) expect(v).toContain('프로젝트 설정 › 접근 권한');
    expect(byKey(koStrings, 'switcherAccessLoadError').length).toBeGreaterThan(0); // the lines exist — the loop above is not empty
    for (const v of byKey(enStrings, 'switcherAccessLoadError')) expect(v).toContain('Access');
    expect(at(ko, 'settings', 'projectAccessTitle')).toBe('접근 권한');
    expect(at(en, 'settings', 'projectAccessTitle')).toBe('Access');
  });
});
