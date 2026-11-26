// @vitest-environment jsdom
//
// story 5032 (C2) — the «+ 새 채널» host: it opens the project dialog ONCE on mount and tells the list when the dialog closes. codex round 1 HIGH: the host closed itself on its first render (the dialog is still «closed» for one render) — so the
// pins here are: no onClose before the dialog was open; onClose after a real close; none while a create is running.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const state = vi.hoisted(() => ({ open: false, creating: false, setOpen: undefined as undefined | ((v: boolean) => void), bump: undefined as undefined | (() => void) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgMemberships: [], orgId: 'org-1', projectMemberships: [], projectId: null }) }));
vi.mock('@/hooks/use-unified-switcher', async () => {
  const React = await import('react');
  return {
    useUnifiedSwitcher: () => {
      const [open, setOpen] = React.useState(false);
      const [, force] = React.useState(0);
      state.setOpen = setOpen; state.bump = () => force((n) => n + 1);
      return { createProjectOpen: open, setCreateProjectOpen: setOpen, creating: state.creating };
    },
  };
});
vi.mock('@/components/nav/create-project-dialog', () => ({ CreateProjectDialog: ({ s, variant }: { s: { createProjectOpen: boolean }; variant?: string }) => <div data-testid="dialog" data-open={String(s.createProjectOpen)} data-variant={variant} /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { state.creating = false; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(onClose: () => void) {
  const { NewChannelDialogHost } = await import('./new-channel-dialog');
  await act(async () => { root.render(<NewChannelDialogHost onClose={onClose} />); });
  await act(async () => { await Promise.resolve(); });
}

describe('[SID:5032] NewChannelDialogHost', () => {
  it('⭐ it opens the dialog (as a channel dialog) and does NOT close itself on mount', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    const d = container.querySelector('[data-testid="dialog"]') as HTMLElement;
    expect(d.getAttribute('data-open')).toBe('true'); // reverted → stays closed
    expect(d.getAttribute('data-variant')).toBe('channel');
    expect(onClose).not.toHaveBeenCalled(); // reverted (the first-render close) → called at once
  });

  it('⭐ a close after it was open tells the list; a close while a create is running does not', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    state.creating = true;
    await act(async () => { state.setOpen!(false); });
    expect(onClose, 'the dialog closed while creating (it closes when the project is made, the hook finishes the rest)').not.toHaveBeenCalled();
    state.creating = false;
    await act(async () => { state.bump!(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
