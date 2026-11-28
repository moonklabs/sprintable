// @vitest-environment jsdom
//
// story 5031 (C1, codex 2 LOW) — the rows we already hold stay while the list is read again (a retry after an error, a refresh after a create): the list says it is being read (`aria-busy`) — there is no skeleton to speak for it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectsSection, type ProjectsSectionProps } from './projects-section';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

function props(over: Partial<ProjectsSectionProps>): ProjectsSectionProps {
  return {
    projects: [{ id: 'p1', name: '알파', description: null }], currentProjectId: 'p1', isAdmin: true, editingId: null, editName: '', editDescription: '', saving: false,
    onEditStart: vi.fn(), onEditName: vi.fn(), onEditDescription: vi.fn(), onEditSave: vi.fn(), onEditCancel: vi.fn(),
    deletingId: null, onDeleteAsk: vi.fn(), message: null, newName: '', newDescription: '', creating: false,
    onNewName: vi.fn(), onNewDescription: vi.fn(), onCreate: vi.fn(), ...over,
  };
}
async function draw(p: ProjectsSectionProps) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ProjectsSection {...p} /></NextIntlClientProvider>); });
}
const list = () => container.querySelector('[data-testid="settings-projects-list"]')!;

describe('[SID:5031] ProjectsSection — rows held while the list is read again', () => {
  it('the rows stay and the list says it is busy while loading; not busy when ok', async () => {
    await draw(props({ loadState: 'loading' }));
    expect(list().textContent).toContain('알파');
    expect(list().getAttribute('aria-busy')).toBe('true');
    await draw(props({ loadState: 'ok' }));
    expect(list().getAttribute('aria-busy')).toBe('false');
  });
  it('an error keeps the rows under the failure banner with its retry; loading with no rows is a skeleton group, not the empty text', async () => {
    const onRetry = vi.fn();
    await draw(props({ loadState: 'error', onRetry }));
    expect(container.querySelector('[data-slot="ds-banner"][data-tone="failed"]')).not.toBeNull();
    expect(list().textContent).toContain('알파');
    await act(async () => { ([...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.common.retry) as HTMLButtonElement).click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    await draw(props({ projects: [], loadState: 'loading' }));
    expect(container.textContent).not.toContain(koMessages.settings.projectListEmpty);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});
