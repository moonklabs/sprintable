// @vitest-environment jsdom
//
// story 4891 — «Add agent» (the Recruit tab) in an organization with NO project: a first person's first agent used to stop at «Please select a project.» with nothing to select.
// PR 5490 pointed it at Settings › Projects; a FAILED projects request is not «no project» → «we couldn't load them» + [Try again] (PR 5507). EVERY member may create a project in Settings (story 4897 —
// the API always allowed it and the form is open to everyone), so the pane never looks at the person's role: an earlier head told non-admins to «ask an admin», which stopped being true. The state is decided
// by `recruitNoProjectState` from the real context values (the state tests below go through every one of them) — reverting any condition turns a state test red; the component tests pin what each state says and draws.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '../../../messages/en.json';
import koMessages from '../../../messages/ko.json';
import { RecruitNoProject, recruitNoProjectState, type RecruitNoProjectState } from './recruit-no-project';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const rec = (m: unknown) => (m as { recruiter: Record<string, string> }).recruiter;
async function render(state: RecruitNoProjectState, locale: 'en' | 'ko' = 'en', onRetry: () => void = () => {}) {
  const messages = locale === 'en' ? enMessages : koMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <RecruitNoProject state={state} createHref="/settings?tab=projects" onRetry={onRetry} />
      </NextIntlClientProvider>,
    );
  });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('what each state says and draws (story 4891)', () => {
  it('⭐create (no project at all — any member): the line + a link to Settings › Projects', async () => {
    await render('create');
    expect(container.textContent).toContain(rec(enMessages).noProjectYet);
    const link = q('recruit-create-project')?.closest('a') ?? q('recruit-create-project');
    expect(link?.getAttribute('href')).toBe('/settings?tab=projects');
    expect(link?.textContent?.trim()).toBe(rec(enMessages).createProject);
    expect(q('recruit-retry-projects')).toBeNull();
  });

  it('⭐failed: «we couldn\'t load your projects» + [Try again] that calls onRetry — never «you have none»', async () => {
    const onRetry = vi.fn();
    await render('failed', 'en', onRetry);
    expect(container.textContent).toContain(rec(enMessages).projectsLoadFailed);
    expect(container.textContent).not.toContain(rec(enMessages).noProjectYet);
    const retry = q('recruit-retry-projects') as HTMLButtonElement | null;
    expect(retry?.textContent?.trim()).toBe(rec(enMessages).projectsRetry);
    await act(async () => { retry!.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('pick (projects exist, none chosen): the old line, no link', async () => {
    await render('pick');
    expect(container.textContent).toContain(rec(enMessages).noProject);
    expect(q('recruit-create-project')).toBeNull();
  });

  it('Korean copy exists for every new key (a missing key would render its name)', async () => {
    for (const [state, key] of [['create', 'noProjectYet'], ['failed', 'projectsLoadFailed']] as const) {
      await render(state, 'ko');
      expect(container.textContent).toContain(rec(koMessages)[key]);
    }
    expect(rec(koMessages).createProject.length).toBeGreaterThan(0);
    expect(rec(koMessages).projectsRetry.length).toBeGreaterThan(0);
  });
});

describe('recruitNoProjectState — through the real states the layout and the shell give (story 4891)', () => {
  const base = { projectId: null as string | null, projectMemberships: [] as unknown[], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false };
  it('⭐no project at all: create — for everyone (the role is not an input at all: the function takes the context only)', () => {
    expect(recruitNoProjectState(base)).toBe('create');
    expect(recruitNoProjectState.length).toBe(1);
  });

  it('⭐a failed projects request is failed — not «none» (create)', () => {
    expect(recruitNoProjectState({ ...base, projectMembershipsFailed: true })).toBe('failed');
  });

  it('⭐a moment the shell has not told the projects yet (the address\'s project resolving · the organization of the address not yet the token\'s) is not «none»', () => {
    expect(recruitNoProjectState({ ...base, projectPathUnresolved: true })).toBe('pick');
    expect(recruitNoProjectState({ ...base, orgSyncPending: true })).toBe('pick');
  });

  it('projects exist (or one is chosen): pick — even if an earlier request had failed', () => {
    expect(recruitNoProjectState({ ...base, projectMemberships: [{ projectId: 'p1' }] })).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectId: 'p1' })).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectMemberships: [{ projectId: 'p1' }], projectMembershipsFailed: true })).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectId: 'p1', projectMembershipsFailed: true })).toBe('pick');
  });
});

describe('the wiring (story 4891)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
  it('⭐no «ask an admin» state or copy is left (a member may create a project)', () => {
    expect(read('recruit-no-project.tsx')).not.toMatch(/ask-admin|noProjectAsk|role\.isAdmin/);
    expect((enMessages as unknown as { recruiter: Record<string, string> }).recruiter.noProjectAsk).toBeUndefined();
    expect((koMessages as unknown as { recruiter: Record<string, string> }).recruiter.noProjectAsk).toBeUndefined();
  });
  it('the tabs hand the component the real state (the dashboard context only — no role) and the Settings › Projects address', () => {
    const src = read('agents-page-tabs.tsx');
    expect(src).toContain("state={recruitNoProjectState(dashboardCtx)}");
    expect(src).toContain("createHref={flatHref('/settings?tab=projects')}");
    expect(src).toContain('onRetry={() => window.location.reload()}'); // the request is the layout's (server): a reload asks it again
  });
  it('the layout tells a failed projects request on its own and the shell carries it in the context', () => {
    expect(read('../../app/(authenticated)/layout.tsx')).toContain('const projectMembershipsFailed = !membershipsRes?.ok;');
    expect(read('../../app/(authenticated)/layout.tsx')).toContain('projectMembershipsFailed={projectMembershipsFailed}');
    const shell = read('../../app/dashboard/dashboard-shell.tsx');
    expect(shell).toContain('projectMembershipsFailed?: boolean;');
    expect(shell).toMatch(/currentMemberType, projectMemberships, projectMembershipsFailed, orgMemberships, orgSyncPending,/);
  });
});
