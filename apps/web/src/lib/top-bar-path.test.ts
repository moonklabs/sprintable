// story 5031 (C1 step 5a · PO 11-27) — the path on the desktop top bar's left: ONE rule for every screen (org › project-or-place › the screen's own title).
// This pins the rule as a table over the four places and the project-scoped screens; top-bar.5a.test.tsx pins what the bar draws from it.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { leadingCrumbs, nodeText, pathScopeFor, placeFirstPath } from './top-bar-path';
import { DEPTH1_ITEMS } from './nav-depth1';

const NAMES: Record<string, string> = { home: '홈', chat: '채팅', agents: '에이전트', settings: '설정' };
const ORG = '올리베이라 조직';
const PROJECT = '스프린터블';

/** the whole path as the bar reads: the crumbs, then the screen's own title when it has one */
function pathOf(pathname: string, title: string, opts: { org?: string | undefined; project?: string | undefined } = { org: ORG, project: PROJECT }): string {
  const crumbs = leadingCrumbs({ pathname, orgName: opts.org, projectName: opts.project, placeName: (p) => NAMES[p]!, placeHref: placeFirstPath, titleText: title });
  return [...crumbs.map((c) => c.label), title].filter(Boolean).join(' › ');
}

describe('the path rule — org › (project when the screen is project-scoped, else the place) › title', () => {
  const table: Array<[string, string, string, string]> = [
    // [what it is, pathname, the screen's title, the path]
    ['홈 first screen (no title of its own)', '/org-briefing', '', `${ORG} › 홈`],
    ['홈 · a screen of the place', '/inbox', '결재함', `${ORG} › 홈 › 결재함`],
    ['채팅 list (its title component draws nothing)', '/chats', '', `${ORG} › 채팅`],
    ['채팅 · a chat room: the room is the last crumb', '/chats/6f1d2c9e', '민 · 디디', `${ORG} › 채팅 › 민 · 디디`],
    ['에이전트 first screen titled «에이전트» says the place once', '/organization/workforce', '에이전트', `${ORG} › 에이전트`],
    ['에이전트 · a screen of the place', '/organization/workforce/runs', '실행 기록', `${ORG} › 에이전트 › 실행 기록`],
    ['설정 · the current tab', '/settings', '프로필', `${ORG} › 설정 › 프로필`],
    ['설정 · another settings screen of the place', '/organization/members', '구성원', `${ORG} › 설정 › 구성원`],
    ['project-scoped screen: the project replaces the place', '/acme/sprintable/flow', '흐름', `${ORG} › ${PROJECT} › 흐름`],
    ['project-scoped detail screen', '/acme/sprintable/docs/some-doc', '문서', `${ORG} › ${PROJECT} › 문서`],
    ['a screen that is in no place (login · unknown) has only the organization', '/login', '', ORG],
  ];
  for (const [what, pathname, title, expected] of table) {
    it(`${what}: ${pathname} → «${expected}»`, () => {
      expect(pathOf(pathname, title)).toBe(expected);
    });
  }

  it('a part that is not known is left out, never made up (no organization name · no project name yet)', () => {
    expect(pathOf('/settings', '프로필', { org: undefined, project: PROJECT })).toBe('설정 › 프로필');
    expect(pathOf('/acme/sprintable/flow', '흐름', { org: ORG, project: undefined })).toBe(`${ORG} › 흐름`);
  });

  it('only a project-scoped route (/[ws]/[proj]/…) is «project»; the four places are «place» and carry their own name', () => {
    expect(pathScopeFor('/acme/sprintable/goals/g1')).toEqual({ kind: 'project' });
    for (const item of DEPTH1_ITEMS) expect(pathScopeFor(item.path)).toEqual({ kind: 'place', place: item.id });
    expect(pathScopeFor('/definitely-not-a-screen')).toEqual({ kind: 'none' });
    expect(pathScopeFor('/login')).toEqual({ kind: 'none' });
  });

  it('crumb destinations: only the place is a link (its first screen); the organization and the project are switcher buttons (no destination)', () => {
    const crumbs = leadingCrumbs({ pathname: '/organization/workforce/runs', orgName: ORG, projectName: PROJECT, placeName: (p) => NAMES[p]!, placeHref: placeFirstPath });
    expect(crumbs.map((c) => [c.key, c.href])).toEqual([['org', undefined], ['place', '/organization/workforce']]); // 5a-2: the organization is a button that opens the project switcher, not a link
    const proj = leadingCrumbs({ pathname: '/acme/sprintable/flow', orgName: ORG, projectName: PROJECT, placeName: (p) => NAMES[p]!, placeHref: placeFirstPath });
    expect(proj.map((c) => [c.key, c.href])).toEqual([['org', undefined], ['project', undefined]]);
  });

  it('nodeText reads the words inside a title element (h1 · span · nested), and nothing from a component that renders on its own', () => {
    expect(nodeText(createElement('h1', { className: 'x' }, '에이전트'))).toBe('에이전트');
    expect(nodeText(createElement('div', null, createElement('span', null, '가'), '나'))).toBe('가나');
    expect(nodeText(createElement(function Own() { return null; }))).toBe('');
    expect(nodeText(null)).toBe('');
  });
});
