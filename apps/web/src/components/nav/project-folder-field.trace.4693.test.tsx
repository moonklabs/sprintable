// @vitest-environment jsdom
// [SID:4693] (UX-1 · D4 · Yuna ④) — the one line under the picked folder in the new-project dialog: «이 폴더에 CLAUDE.md 파일이 있어요 — …». Information only (no
// button — the project does not exist yet). It follows the value, names the file whose runtime the app found first, and is not there in a browser, in an older
// app (no hand), when nothing is found or when that file's runtime is not on this computer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectFolderField } from './project-folder-field';

const { appRef } = vi.hoisted(() => ({ appRef: { current: null as null | Record<string, unknown> } }));
vi.mock('@/lib/desktop-app', async (importActual) => ({ ...(await importActual<typeof import('@/lib/desktop-app')>()), desktopApp: () => appRef.current ?? undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); appRef.current = null; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const CL = { runtime: 'claude', version: '2.1.0', executable: '/b/claude' };
const CX = { runtime: 'codex', version: '0.1.0', executable: '/b/codex' };
const appWith = (runtimes: unknown[], folderTraces?: unknown) => ({ inApp: true, device: { name: 'x' }, runtimes, pickFolder: async () => null, ...(folderTraces ? { folderTraces } : {}) });
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
async function render(value: string | null) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ProjectFolderField value={value} onChange={() => {}} idPrefix="t" /></NextIntlClientProvider>);
  });
  await settle();
}
const line = () => container.querySelector('[data-testid="project-folder-trace"]');

describe('ProjectFolderField — the trace line (4693 ④)', () => {
  it('a picked folder with a CLAUDE.md → the line with that file\'s name (Yuna\'s words, the {file} filled) · the app was asked about THAT path and about no agent', async () => {
    const ask = vi.fn(async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] }));
    appRef.current = appWith([CL], ask);
    await render('/Users/t/work/a');
    expect(line()?.textContent).toBe('이 폴더에 CLAUDE.md 파일이 있어요 — 프로젝트를 만든 뒤 채용관에서 이 폴더의 에이전트로 채용할 수 있어요.');
    expect(ask).toHaveBeenCalledWith({ path: '/Users/t/work/a', agentIds: [] });
    expect(line()?.querySelector('button, a')).toBeNull(); // information only — no button on the line
  });

  it('both files → the file of the runtime the app found first (codex first → AGENTS.md)', async () => {
    appRef.current = appWith([CX, CL], async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'codex' }], agents: [] }));
    await render('/Users/t/work/a');
    expect(line()?.textContent).toContain('AGENTS.md');
  });

  it('no line: nothing in the folder · a file whose runtime is not on this computer · an older app (no hand) · no folder picked yet · a browser', async () => {
    appRef.current = appWith([CL], async () => ({ traces: [], agents: [] })); await render('/Users/t/work/a'); expect(line()).toBeNull();
    appRef.current = appWith([CX], async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] })); await render('/Users/t/work/b'); expect(line()).toBeNull();
    appRef.current = appWith([CL]); await render('/Users/t/work/c'); expect(line()).toBeNull();
    const ask = vi.fn(async () => ({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] }));
    appRef.current = appWith([CL], ask); await render(null); expect(line()).toBeNull(); expect(ask).not.toHaveBeenCalled();
    appRef.current = null; await render('/Users/t/work/d'); expect(container.querySelector('[data-testid="project-folder-field"]')).toBeNull();
  });

  it('it follows the value: a new pick asks again (the old line is not shown for the new folder) · cleared → gone', async () => {
    const ask = vi.fn(async (a: { path?: string }) => (a.path === '/Users/t/work/a' ? { traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] } : { traces: [], agents: [] }));
    appRef.current = appWith([CL], ask);
    await render('/Users/t/work/a'); expect(line()).not.toBeNull();
    await render('/Users/t/work/b'); expect(line()).toBeNull(); expect(ask).toHaveBeenLastCalledWith({ path: '/Users/t/work/b', agentIds: [] });
    await render('/Users/t/work/a'); expect(line()).not.toBeNull();
    await render(null); expect(line()).toBeNull();
  });

  it('while the app has not answered for a NEW folder, the old folder\'s line is not shown for it', async () => {
    let answerB!: (v: unknown) => void;
    const ask = vi.fn((a: { path?: string }) => (a.path === '/Users/t/work/a'
      ? Promise.resolve({ traces: [{ file: 'CLAUDE.md', runtime: 'claude' }], agents: [] })
      : new Promise((r) => { answerB = r; })));
    appRef.current = appWith([CL], ask);
    await render('/Users/t/work/a'); expect(line()).not.toBeNull();
    await render('/Users/t/work/b'); // asked, not answered yet
    expect(line()).toBeNull();
    await act(async () => { answerB({ traces: [{ file: 'AGENTS.md', runtime: 'codex' }], agents: [] }); });
    await settle();
    expect(line()).toBeNull(); // codex is not on this computer (only claude was found)
  });
});
