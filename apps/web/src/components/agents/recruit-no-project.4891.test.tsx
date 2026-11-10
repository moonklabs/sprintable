// @vitest-environment jsdom
//
// story 4891 — «Add agent» (the Recruit tab) in an organization with NO project: a first person's first agent used to stop at «Please select a project.» with nothing to select.
// PR 5490 pointed it at Settings › Projects; Kadir's notes on it (this follow-up): that page has no create form for a person who is not an admin → they are asked to turn to an admin instead (no button);
// and a FAILED projects request is not «no project» → «we couldn't load them» + [Try again]. The state is decided by `recruitNoProjectState` from the real context values (the state tests below go
// through every one of them) — reverting any condition turns a state test red; the component tests pin what each state says and draws.
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
  it('⭐create (admin · no project at all): the line + a link to Settings › Projects', async () => {
    await render('create');
    expect(container.textContent).toContain(rec(enMessages).noProjectYet);
    const link = q('recruit-create-project')?.closest('a') ?? q('recruit-create-project');
    expect(link?.getAttribute('href')).toBe('/settings?tab=projects');
    expect(link?.textContent?.trim()).toBe(rec(enMessages).createProject);
    expect(q('recruit-retry-projects')).toBeNull();
  });

  it('⭐ask-admin (not an admin · no project at all): asked to turn to an admin — no button to a screen with nothing to do', async () => {
    await render('ask-admin');
    expect(container.textContent).toContain(rec(enMessages).noProjectAsk);
    expect(q('recruit-create-project')).toBeNull();
    expect(q('recruit-retry-projects')).toBeNull();
  });

  it('none (no project at all, role not known yet): the line only — no button either way', async () => {
    await render('none');
    expect(container.textContent).toContain(rec(enMessages).noProjectYet);
    expect(q('recruit-create-project')).toBeNull();
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
    for (const [state, key] of [['create', 'noProjectYet'], ['ask-admin', 'noProjectAsk'], ['failed', 'projectsLoadFailed']] as const) {
      await render(state, 'ko');
      expect(container.textContent).toContain(rec(koMessages)[key]);
    }
    expect(rec(koMessages).createProject.length).toBeGreaterThan(0);
    expect(rec(koMessages).projectsRetry.length).toBeGreaterThan(0);
  });
});

describe('recruitNoProjectState — through the real states the layout and the shell give (story 4891)', () => {
  const base = { projectId: null as string | null, projectMemberships: [] as unknown[], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false };
  const admin = { known: true, isAdmin: true };
  const member = { known: true, isAdmin: false };

  it('no project at all: an admin may create (create) · a member is told to ask (ask-admin) · an unknown role gets the line only (none)', () => {
    expect(recruitNoProjectState(base, admin)).toBe('create');
    expect(recruitNoProjectState(base, member)).toBe('ask-admin');
    expect(recruitNoProjectState(base, { known: false, isAdmin: true })).toBe('none');
  });

  it('⭐a failed projects request is failed for everyone — not «none», not «ask an admin»', () => {
    expect(recruitNoProjectState({ ...base, projectMembershipsFailed: true }, admin)).toBe('failed');
    expect(recruitNoProjectState({ ...base, projectMembershipsFailed: true }, member)).toBe('failed');
  });

  it('⭐a moment the shell has not told the projects yet (the address\'s project resolving · the organization of the address not yet the token\'s) is not «none»', () => {
    expect(recruitNoProjectState({ ...base, projectPathUnresolved: true }, admin)).toBe('pick');
    expect(recruitNoProjectState({ ...base, orgSyncPending: true }, admin)).toBe('pick');
  });

  it('projects exist (or one is chosen): pick — even if an earlier request had failed', () => {
    expect(recruitNoProjectState({ ...base, projectMemberships: [{ projectId: 'p1' }] }, admin)).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectId: 'p1' }, admin)).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectMemberships: [{ projectId: 'p1' }], projectMembershipsFailed: true }, admin)).toBe('pick');
    expect(recruitNoProjectState({ ...base, projectId: 'p1', projectMembershipsFailed: true }, admin)).toBe('pick');
  });
});

describe('the wiring (story 4891)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
  it('the tabs hand the component the real state (the dashboard context + the person\'s role) and the Settings › Projects address', () => {
    const src = read('agents-page-tabs.tsx');
    expect(src).toContain("state={recruitNoProjectState(dashboardCtx, { known: meLoaded, isAdmin })}");
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
