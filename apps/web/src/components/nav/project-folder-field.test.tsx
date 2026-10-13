// @vitest-environment jsdom
// [SID:4681] (D3 · piece ③): the «이 컴퓨터의 폴더» field exists only inside the desktop app; [폴더 고르기] takes the app's chooser's answer
// (a path → shown · null → nothing changes); [지우기] drops it; the shown path reads `~/…` with the last folder's name kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectFolderField, displayFolder } from './project-folder-field';

const { appRef } = vi.hoisted(() => ({ appRef: { current: null as null | { pickFolder: () => Promise<string | null> } } }));
vi.mock('@/lib/desktop-app', () => ({ desktopApp: () => appRef.current ?? undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  appRef.current = null;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const nav = koMessages.nav as Record<string, string>;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

async function render(value: string | null, onChange: (p: string | null) => void) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ProjectFolderField value={value} onChange={onChange} idPrefix="t" />
      </NextIntlClientProvider>,
    );
  });
}

describe('displayFolder', () => {
  it('home as ~ · a short path as it is · a long one elided in the middle with the last folder kept', () => {
    expect(displayFolder('/Users/t/work/a')).toBe('~/work/a');
    expect(displayFolder('/Users/t')).toBe('~');
    expect(displayFolder('/Volumes/x/a')).toBe('/Volumes/x/a');
    const long = '/Users/t/Documents/clients/moonklabs/sprintable/apps/web/src/components/nav';
    const shown = displayFolder(long);
    expect(shown.length).toBeLessThanOrEqual(44);
    expect(shown.startsWith('~/Documents')).toBe(true);
    expect(shown.endsWith('…/nav')).toBe(true);
    expect(displayFolder('/Usersx/t/a')).toBe('/Usersx/t/a'); // not a home
  });
});

describe('ProjectFolderField', () => {
  it('in a browser (no bridge): nothing is drawn', async () => {
    await render(null, () => {});
    expect(container.querySelector('[data-testid="project-folder-field"]')).toBeNull();
  });

  it('in the app: label · hint · [폴더 고르기]; a picked path → onChange(path); null (canceled) → no call', async () => {
    const pickFolder = vi.fn<() => Promise<string | null>>();
    appRef.current = { pickFolder };
    const onChange = vi.fn();
    await render(null, onChange);
    const field = container.querySelector('[data-testid="project-folder-field"]')!;
    expect(field.textContent).toContain(nav.switcherFolderLabel);
    expect(field.textContent).toContain(nav.switcherOptionalLabel);
    expect(field.textContent).toContain(nav.switcherFolderHint);
    expect(field.querySelector('[data-testid="project-folder-path"]')).toBeNull();
    const pick = field.querySelector('[data-testid="project-folder-pick"]') as HTMLButtonElement;
    expect(pick.textContent).toBe(nav.switcherFolderPick);
    pickFolder.mockResolvedValueOnce(null);
    await act(async () => { pick.click(); });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    pickFolder.mockResolvedValueOnce('/Users/t/work/a');
    await act(async () => { pick.click(); });
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/Users/t/work/a');
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it('a chooser that throws changes nothing', async () => {
    appRef.current = { pickFolder: async () => { throw new Error('bridge gone'); } };
    const onChange = vi.fn();
    await render(null, onChange);
    const pick = container.querySelector('[data-testid="project-folder-pick"]') as HTMLButtonElement;
    await act(async () => { pick.click(); });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    expect(pick.disabled).toBe(false); // picking is over
  });

  it('[Yuna 5067 ①] a 60-character path: on its own line under the buttons, no CSS end-cut (break-all · no truncate), the rendered text ends with the last folder\'s name', async () => {
    appRef.current = { pickFolder: async () => null };
    const long = '/Users/yuna/dev/sprintable-lanes/yuna/sprintable/apps/webnav';
    expect(long.length).toBe(60);
    await render(long, () => {});
    const field = container.querySelector('[data-testid="project-folder-field"]')!;
    const code = field.querySelector('[data-testid="project-folder-path"]')!;
    expect(code.textContent!.endsWith('/webnav')).toBe(true);
    expect(code.textContent!.length).toBeLessThanOrEqual(44);
    expect(code.className).toContain('break-all');
    expect(code.className).not.toContain('truncate');
    // its own line: not inside the button row
    const row = field.querySelector('[data-testid="project-folder-pick"]')!.parentElement!;
    expect(row.contains(code)).toBe(false);
    expect(row.querySelector('[data-testid="project-folder-clear"]')).not.toBeNull(); // [지우기] stays beside [폴더 고르기]
  });

  it('with a value: the path shown as ~/… with the full path in title · [지우기] → onChange(null)', async () => {
    appRef.current = { pickFolder: async () => null };
    const onChange = vi.fn();
    await render('/Users/t/work/a', onChange);
    const path = container.querySelector('[data-testid="project-folder-path"]')!;
    expect(path.textContent).toBe('~/work/a');
    expect(path.getAttribute('title')).toBe('/Users/t/work/a');
    const clear = container.querySelector('[data-testid="project-folder-clear"]') as HTMLButtonElement;
    expect(clear.textContent).toBe(nav.switcherFolderClear);
    await act(async () => { clear.click(); });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
