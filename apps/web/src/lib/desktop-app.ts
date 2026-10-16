// story 4679 (UX-1 · D1): the desktop app's bridge, when this page runs inside it. The app's web view has ONE preload
// (sprintable-mobile desktop-electron/src/web-preload.ts) that exposes a frozen `window.sprintableDesktop` on our origin only —
// three values and three hands, nothing else. In a browser there is none (`desktopApp()` → undefined) and every screen stays as it
// is. D2 (hiring in the app) and D3 (a project's folder) read it through this one function — never `window` directly.

export const DESKTOP_RUNTIMES_IN_APP = ['claude', 'codex'] as const;
export type DesktopRuntimeInApp = (typeof DESKTOP_RUNTIMES_IN_APP)[number];

/** a runtime the app found on this computer — name · version · where (the app's «이 컴퓨터에서 찾은 에이전트» panel's picked ones) */
export interface DesktopRuntimeFound { runtime: DesktopRuntimeInApp; version: string; executable: string }

export interface SprintableDesktop {
  readonly inApp: true;
  readonly device: { readonly name: string };
  /** read once when the page loaded — a page opened later sees the app's newer list */
  readonly runtimes: readonly DesktopRuntimeFound[];
  /** story 4691: the app's «found here» list as it changes. `listener` is called ONCE right away with the newest list (so a page that
   *  loaded before detection finished — or after — is never raced), then only when the list CHANGES. Returns the unsubscribe.
   *  Absent in an older app (that page keeps the one read above). Read it through `subscribeDesktopApp` — never call it from a screen. */
  subscribeRuntimes?(listener: (runtimes: readonly DesktopRuntimeFound[]) => void): () => void;
  /** the OS folder chooser: a folder inside home, or null (canceled · refused — the reason comes back from setProjectFolder) */
  pickFolder(): Promise<string | null>;
  /** start that agent on this computer: the app opens its setup page (with `agent=` in the fragment) — no link round trip */
  startHere(a: { agentId: string }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** keep a project's folder on this computer — `path` must be one pickFolder returned in this page (else `problem: 'not_picked'`);
   *  the app checks the folder again (inside home · not its own folder). A page never names a folder itself. */
  setProjectFolder(a: { projectId: string; path: string }): Promise<{ ok: true } | { problem: string }>;
  /** story 4693 (UX-1 · D4): does a folder carry CLAUDE.md / AGENTS.md — only whether those two names exist (the app never opens a file), and
   *  which of `agentIds` already have a profile in that folder on this computer. `{projectId}` = the folder the app kept for that project;
   *  `{path}` = one `pickFolder` returned in this page. Absent in an older app (the page then shows nothing new). Read it through
   *  `readFolderTraces` — never call it from a screen. */
  folderTraces?(a: { projectId?: string; path?: string; agentIds?: readonly string[] }): Promise<unknown>;
}

/** story 4693: the two files the app looks for, and the runtime each one means (the app's own table — design 4693 §2) */
export interface FolderTrace { file: 'CLAUDE.md' | 'AGENTS.md'; runtime: DesktopRuntimeInApp }
export interface FolderTracesAnswer { traces: FolderTrace[]; agents: string[] }
export const NO_FOLDER_TRACES: FolderTracesAnswer = Object.freeze({ traces: [], agents: [] }) as FolderTracesAnswer;
const TRACE_FILES: Record<string, DesktopRuntimeInApp> = { 'CLAUDE.md': 'claude', 'AGENTS.md': 'codex' };
const MAX_TRACE_AGENTS = 8;

const isRuntime = (v: unknown): v is DesktopRuntimeFound => {
  const r = v as Partial<DesktopRuntimeFound> | null;
  return !!r && typeof r === 'object' && (DESKTOP_RUNTIMES_IN_APP as readonly string[]).includes(r.runtime as string) && typeof r.version === 'string' && typeof r.executable === 'string';
};

/** the bridge when its shape checks — anything else (a browser · an older app · a page outside the app's origin) is undefined */
export function desktopAppOf(candidate: unknown): SprintableDesktop | undefined {
  const d = candidate as Partial<SprintableDesktop> | null | undefined;
  if (!d || typeof d !== 'object' || d.inApp !== true) return undefined;
  if (!d.device || typeof d.device !== 'object' || typeof d.device.name !== 'string') return undefined;
  if (!Array.isArray(d.runtimes) || !d.runtimes.every(isRuntime)) return undefined;
  if (typeof d.pickFolder !== 'function' || typeof d.startHere !== 'function' || typeof d.setProjectFolder !== 'function') return undefined;
  // 4691: the fourth hand is OPTIONAL (an older app has none → the page keeps its first read) — but present means a function
  if (d.subscribeRuntimes !== undefined && typeof d.subscribeRuntimes !== 'function') return undefined;
  // 4693: the same — an older app has no `folderTraces` (the page shows nothing new); present means a function
  if (d.folderTraces !== undefined && typeof d.folderTraces !== 'function') return undefined;
  return d as SprintableDesktop;
}

/** story 4693: ask the app about a folder. The answer is read like the first read of the runtimes: anything off the closed shape is dropped (a
 *  trace of a file that is not in the table · an agent id the page did not ask about · more than eight ids), and an app without the hand, a
 *  refusal or a throw is the same «nothing there». Never rejects. */
export async function readFolderTraces(ask: SprintableDesktop['folderTraces'], a: { projectId?: string; path?: string; agentIds?: readonly string[] }): Promise<FolderTracesAnswer> {
  if (typeof ask !== 'function') return NO_FOLDER_TRACES;
  try {
    const raw = (await ask(a)) as { traces?: unknown; agents?: unknown } | null;
    if (!raw || typeof raw !== 'object') return NO_FOLDER_TRACES;
    const asked = new Set(a.agentIds ?? []);
    const traces: FolderTrace[] = [];
    if (Array.isArray(raw.traces)) {
      for (const t of raw.traces as Array<{ file?: unknown; runtime?: unknown } | null>) {
        const file = typeof t?.file === 'string' ? t.file : '';
        if (Object.prototype.hasOwnProperty.call(TRACE_FILES, file) && t?.runtime === TRACE_FILES[file] && !traces.some((x) => x.file === file)) traces.push({ file: file as FolderTrace['file'], runtime: TRACE_FILES[file]! });
      }
    }
    const agents = Array.isArray(raw.agents)
      ? [...new Set((raw.agents as unknown[]).filter((x): x is string => typeof x === 'string' && asked.has(x)))].slice(0, MAX_TRACE_AGENTS)
      : [];
    return traces.length || agents.length ? { traces, agents } : NO_FOLDER_TRACES;
  } catch {
    return NO_FOLDER_TRACES;
  }
}

/** story 4693: the one trace a screen names — of the files found, the one whose runtime the app found FIRST on this computer (bridge order = the
 *  runtime default's rule, D2); none of them found here → undefined (nothing to offer: that runtime cannot start). The recruiter's card and the
 *  new-project dialog's line both call this, so the two places always name the same file. */
export function pickFolderTrace(traces: readonly FolderTrace[], found: readonly DesktopRuntimeFound[]): FolderTrace | undefined {
  for (const f of found) {
    const t = traces.find((x) => x.runtime === f.runtime);
    if (t) return t;
  }
  return undefined;
}

const rawBridge = (): SprintableDesktop | undefined => {
  if (typeof window === 'undefined') return undefined;
  return desktopAppOf((window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop);
};

// story 4691: the newest list the app told us (through `subscribeRuntimes`), kept here so `desktopApp()` can answer with it. The
// derived bridge is memoized on (raw bridge · list) — the SAME list gives the SAME object, or useSyncExternalStore would loop.
let latestRuntimes: readonly DesktopRuntimeFound[] | null = null;
let derived: { raw: SprintableDesktop; list: readonly DesktopRuntimeFound[]; out: SprintableDesktop } | null = null;
const listeners = new Set<() => void>();
let stopBridge: (() => void) | null = null;

const sameList = (a: readonly DesktopRuntimeFound[], b: readonly DesktopRuntimeFound[]) =>
  a.length === b.length && a.every((r, i) => r.runtime === b[i]!.runtime && r.version === b[i]!.version && r.executable === b[i]!.executable);

/** this page inside the desktop app, or undefined (a browser · the server). Inside the app after the app's list changed: the
 *  bridge with the newest `runtimes` (everything else as the app gave it). */
export function desktopApp(): SprintableDesktop | undefined {
  const raw = rawBridge();
  if (!raw || !latestRuntimes || sameList(latestRuntimes, raw.runtimes)) return raw;
  if (derived && derived.raw === raw && derived.list === latestRuntimes) return derived.out;
  const out: SprintableDesktop = { ...raw, runtimes: latestRuntimes };
  derived = { raw, list: latestRuntimes, out };
  return out;
}

/** story 4691 — for useSyncExternalStore: tell me when the app's found list changed. The app calls back right away with its newest
 *  list, so a page that loaded before (or after) detection finished is never raced. Nothing to subscribe to (a browser · an older
 *  app without `subscribeRuntimes`) → a no-op, and the page keeps its one read. One subscription to the app is shared by all. */
export function subscribeDesktopApp(listen: () => void): () => void {
  const raw = rawBridge();
  if (!raw?.subscribeRuntimes) return () => undefined;
  listeners.add(listen);
  if (!stopBridge) {
    try {
      stopBridge = raw.subscribeRuntimes((next) => {
        // the app's answer is checked like the first read: anything off the closed shape is ignored (the page keeps what it has)
        if (!Array.isArray(next) || !next.every(isRuntime)) return;
        const have = latestRuntimes ?? rawBridge()?.runtimes ?? [];
        if (sameList(have, next)) return;
        latestRuntimes = [...next];
        for (const l of [...listeners]) l();
      });
    } catch { stopBridge = null; }
  }
  return () => {
    listeners.delete(listen);
    if (listeners.size === 0 && stopBridge) {
      const stop = stopBridge;
      stopBridge = null;
      try { stop(); } catch { /* the app is gone — nothing to release */ }
    }
  };
}

/** tests only: forget the app's list and the shared subscription */
export function __resetDesktopAppForTest(): void {
  latestRuntimes = null;
  derived = null;
  listeners.clear();
  stopBridge = null;
}
