// @vitest-environment jsdom
//
// story 4891 — «Add agent» (the Recruit tab) in an organization with NO project: a first person's first agent used to stop at «Please select a project.» with nothing to select.
// With no project at all the tab says so and points at the project creation that already exists (Settings › Projects); with projects but none chosen the old line stays.
// Reverting `noProjectAtAll ? …` (the line only · no link) or the link target turns these red; the wiring test pins that the tab hands the component the real «no project at all» answer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '../../../messages/en.json';
import koMessages from '../../../messages/ko.json';
import { RecruitNoProject } from './recruit-no-project';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const rec = (m: unknown) => (m as { recruiter: Record<string, string> }).recruiter;
async function render(noProjectAtAll: boolean, locale: 'en' | 'ko' = 'en') {
  const messages = locale === 'en' ? enMessages : koMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <RecruitNoProject noProjectAtAll={noProjectAtAll} createHref="/settings?tab=projects" />
      </NextIntlClientProvider>,
    );
  });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('Recruit tab without a project (story 4891)', () => {
  it('⭐no project at all: says so, and the way on is a link to Settings › Projects', async () => {
    await render(true);
    expect(container.textContent).toContain(rec(enMessages).noProjectYet);
    expect(container.textContent).not.toContain(rec(enMessages).noProject);
    const link = q('recruit-create-project')?.closest('a') ?? q('recruit-create-project');
    expect(link?.getAttribute('href')).toBe('/settings?tab=projects');
    expect(link?.textContent?.trim()).toBe(rec(enMessages).createProject);
  });

  it('projects exist but none is chosen: the old line stays and there is no create link (the switcher has them)', async () => {
    await render(false);
    expect(container.textContent).toContain(rec(enMessages).noProject);
    expect(container.textContent).not.toContain(rec(enMessages).noProjectYet);
    expect(q('recruit-create-project')).toBeNull();
  });

  it('Korean copy exists for both new keys (a key missing in ko would render the key name)', async () => {
    await render(true, 'ko');
    expect(container.textContent).toContain(rec(koMessages).noProjectYet);
    expect(rec(koMessages).createProject.length).toBeGreaterThan(0);
    expect(container.textContent).toContain(rec(koMessages).createProject);
  });

  it('the Agents tabs hand the component the real answer (isNoProjectAtAll of the dashboard context) and the Settings › Projects address', () => {
    const src = readFileSync(resolve(__dirname, 'agents-page-tabs.tsx'), 'utf8');
    expect(src).toMatch(/<RecruitNoProject noProjectAtAll=\{isNoProjectAtAll\(dashboardCtx\)\} createHref=\{flatHref\('\/settings\?tab=projects'\)\} \/>/);
    expect(src).not.toContain("tRecruiter('noProject')");
  });
});
