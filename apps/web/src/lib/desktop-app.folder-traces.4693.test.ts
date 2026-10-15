// [SID:4693] (UX-1 · D4) — the bridge's fifth hand as the page reads it: `folderTraces` is OPTIONAL (an older app has none → the page shows nothing new),
// the app's answer is read like every other answer from it — closed shape, only what the page asked about — and a refusal or a throw is «nothing there».
import { describe, expect, it, vi } from 'vitest';
import { desktopAppOf, NO_FOLDER_TRACES, pickFolderTrace, readFolderTraces, type DesktopRuntimeFound } from './desktop-app';

const bridge = (more: Record<string, unknown> = {}) => ({
  inApp: true, device: { name: 'x' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }), ...more,
});
const CL: DesktopRuntimeFound = { runtime: 'claude', version: '2.1.0', executable: '/b/claude' };
const CX: DesktopRuntimeFound = { runtime: 'codex', version: '0.1.0', executable: '/b/codex' };

describe('desktopAppOf — folderTraces is optional, and a function when present', () => {
  it('an app without it passes (an older app) · a function passes · anything else → not the app (the page keeps every screen as it is)', () => {
    expect(desktopAppOf(bridge())).toBeDefined();
    expect(desktopAppOf(bridge({ folderTraces: async () => ({ traces: [], agents: [] }) }))).toBeDefined();
    for (const bad of ['x', 5, {}, null]) expect(desktopAppOf(bridge({ folderTraces: bad })), String(bad)).toBeUndefined();
  });
});

describe('readFolderTraces — the app\'s answer, closed', () => {
  it('only the table\'s two files with their own runtime · the same file once · a file the table has not, or with another runtime → dropped', async () => {
    const ask = vi.fn(async () => ({ traces: [
      { file: 'CLAUDE.md', runtime: 'claude' }, { file: 'CLAUDE.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'codex' },
      { file: 'GEMINI.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'claude' }, { file: 'constructor', runtime: 'claude' }, { file: 5, runtime: 'claude' }, null, 'x',
    ], agents: [] }));
    expect((await readFolderTraces(ask, { projectId: 'p1' })).traces).toEqual([{ file: 'CLAUDE.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'codex' }]);
    expect(ask).toHaveBeenCalledWith({ projectId: 'p1' });
    // a file with the OTHER runtime's name on it is not the table's pair — not drawn at all (nothing is guessed from the file name alone)
    expect((await readFolderTraces(async () => ({ traces: [{ file: 'AGENTS.md', runtime: 'claude' }, { file: 'CLAUDE.md', runtime: 'codex' }], agents: [] }), { projectId: 'p1' })).traces).toEqual([]);
  });

  it('agent ids: only the ones the page asked about · once each · at most eight · non-strings dropped', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const ask = async () => ({ traces: [], agents: ['intruder', ...many, 'a1', 7, null] });
    const r = await readFolderTraces(ask, { path: '/Users/t/p', agentIds: many });
    expect(r.agents).toEqual(many.slice(0, 8));
    expect((await readFolderTraces(async () => ({ traces: [], agents: ['a1'] }), { projectId: 'p' })).agents).toEqual([]); // asked about nobody → nobody answered
  });

  it('nothing to say / an app without the hand / a refusal / a throw / a body of another shape → the same «nothing there» (never rejects)', async () => {
    expect(await readFolderTraces(undefined, { projectId: 'p' })).toBe(NO_FOLDER_TRACES);
    expect(await readFolderTraces(async () => ({ traces: [], agents: [] }), { projectId: 'p' })).toBe(NO_FOLDER_TRACES);
    expect(await readFolderTraces(async () => { throw new Error('gone'); }, { projectId: 'p' })).toBe(NO_FOLDER_TRACES);
    for (const odd of [null, undefined, 'x', 5, [], { traces: 'x', agents: 7 }]) expect(await readFolderTraces(async () => odd, { projectId: 'p' }), JSON.stringify(odd)).toBe(NO_FOLDER_TRACES);
  });
});

describe('pickFolderTrace — the file whose runtime the app found FIRST (the runtime default\'s rule) · none found here → nothing to offer', () => {
  const both = [{ file: 'CLAUDE.md', runtime: 'claude' }, { file: 'AGENTS.md', runtime: 'codex' }] as const;
  it('bridge order decides, not file order', () => {
    expect(pickFolderTrace(both, [CX, CL])?.file).toBe('AGENTS.md');
    expect(pickFolderTrace(both, [CL, CX])?.file).toBe('CLAUDE.md');
    expect(pickFolderTrace([both[0]], [CX, CL])?.file).toBe('CLAUDE.md');
  });
  it('a file whose runtime is not on this computer is not offered (it could not start) · nothing found → undefined', () => {
    expect(pickFolderTrace([both[0]], [CX])).toBeUndefined();
    expect(pickFolderTrace(both, [])).toBeUndefined();
    expect(pickFolderTrace([], [CL, CX])).toBeUndefined();
  });
});
