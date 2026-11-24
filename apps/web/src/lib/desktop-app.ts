// story 4679 (UX-1 · D1): the desktop app's bridge, when this page runs inside it. The app's web view has ONE preload
// (sprintable-mobile desktop-electron/src/web-preload.ts) that exposes a frozen `window.sprintableDesktop` on our origin only —
// three values and three hands, nothing else. In a browser there is none (`desktopApp()` → undefined) and every screen stays as it
// is. D2 (hiring in the app) and D3 (a project's folder) read it through this one function — never `window` directly.

import { ENABLED_DESKTOP_RUNTIME_IDS, type EnabledDesktopRuntimeId } from '@/lib/desktop-runtimes';

export const DESKTOP_RUNTIMES_IN_APP = ENABLED_DESKTOP_RUNTIME_IDS; // story 5008 (A1): the one list is lib/desktop-runtimes.ts
export type DesktopRuntimeInApp = EnabledDesktopRuntimeId;

/** a runtime the app found on this computer — name · version · where (the app's «이 컴퓨터에서 찾은 에이전트» panel's picked ones) */
export interface DesktopRuntimeFound { runtime: DesktopRuntimeInApp; version: string; executable: string }

/** story 4971 ③: the build the app offers as an update, and how far it is — the app's own closed shape (a canonical N.N.N and one of four phases) */
export const APP_UPDATE_PHASES = ['available', 'downloading', 'installing', 'failed'] as const;
export interface AppUpdateOffer { readonly version: string; readonly phase: (typeof APP_UPDATE_PHASES)[number] }
const OFFER_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** the offer when it fits the closed shape — anything else (extra keys are dropped, a bad version or phase is no offer) is null */
export function appUpdateOfferOf(raw: unknown): AppUpdateOffer | null {
  const o = raw as Partial<AppUpdateOffer> | null | undefined;
  if (!o || typeof o !== 'object' || typeof o.version !== 'string' || !OFFER_VERSION.test(o.version) || !(APP_UPDATE_PHASES as readonly string[]).includes(o.phase as string)) return null;
  return Object.freeze({ version: o.version, phase: o.phase as AppUpdateOffer['phase'] });
}

export interface SprintableDesktop {
  readonly inApp: true;
  readonly device: { readonly name: string };
  /** story 4970: the build of the app this page runs in (its own version string). Absent in an older app — the page then says only which computer it is. Read it through `appVersionOf`. */
  readonly appVersion?: string;
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
  /** story 4971 ③: the build the app offers as an update when this page loaded (absent when none · in an older app). Read it through `appUpdate`. */
  readonly update?: AppUpdateOffer;
  /** story 4971 ③: press «update» — the app downloads the build it offered, then restarts into it. Takes NOTHING from the page. Absent in an older app. Call it through `pressAppUpdate`. */
  startUpdate?(): Promise<{ ok: true } | { ok: false; code: string }>;
  /** story 4971 ③: the offered build as it changes (the current one at once, null when none). Absent in an older app. Read it through `subscribeAppUpdate`. */
  subscribeUpdate?(listener: (offer: AppUpdateOffer | null) => void): () => void;
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

const MAX_APP_VERSION = 64;
/** story 4970: the app's build string, or undefined (an older app · anything that is not a short string) */
export function appVersionOf(bridge: SprintableDesktop | undefined): string | undefined {
  const v = bridge?.appVersion;
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_APP_VERSION ? v : undefined;
}

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
  // 4971: the update hands are optional the same way (an older app has none → no update line); present means a function
  if (d.startUpdate !== undefined && typeof d.startUpdate !== 'function') return undefined;
  if (d.subscribeUpdate !== undefined && typeof d.subscribeUpdate !== 'function') return undefined;
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

// ── story 4971 ③: the offered update — the app's current offer (read at load, then pushed). The SAME value gives the SAME object (useSyncExternalStore must not loop). ──
let pushedOffer: AppUpdateOffer | null | undefined; // undefined = nothing pushed yet (the load-time value stands)
let offerNow: AppUpdateOffer | null = null;
const offerListeners = new Set<() => void>();
let stopOffer: (() => void) | null = null;
const sameOffer = (a: AppUpdateOffer | null, b: AppUpdateOffer | null) => (a === null || b === null ? a === b : a.version === b.version && a.phase === b.phase);

/** the build the app offers as an update right now, or null (a browser · an older app · nothing on offer) */
export function appUpdate(): AppUpdateOffer | null {
  const raw = rawBridge();
  if (!raw) return null;
  const next = pushedOffer !== undefined ? pushedOffer : appUpdateOfferOf(raw.update);
  if (sameOffer(offerNow, next)) return offerNow;
  offerNow = next;
  return offerNow;
}

/** story 4971 — for useSyncExternalStore: tell me when the offer changed. The app calls back right away with the current one. Nothing to subscribe to (a browser · an app without `subscribeUpdate`) → a no-op. One subscription to the app is shared by all. */
export function subscribeAppUpdate(listen: () => void): () => void {
  const raw = rawBridge();
  if (!raw?.subscribeUpdate) return () => undefined;
  offerListeners.add(listen);
  if (!stopOffer) {
    try {
      stopOffer = raw.subscribeUpdate((next) => {
        const checked = next === null ? null : appUpdateOfferOf(next);
        if (next !== null && checked === null) return; // not the closed shape: ignored
        if (sameOffer(pushedOffer === undefined ? appUpdateOfferOf(raw.update) : pushedOffer, checked)) { pushedOffer = checked; return; }
        pushedOffer = checked;
        for (const l of [...offerListeners]) l();
      });
    } catch { stopOffer = null; }
  }
  return () => {
    offerListeners.delete(listen);
    if (offerListeners.size === 0 && stopOffer) {
      const stop = stopOffer;
      stopOffer = null;
      try { stop(); } catch { /* the app is gone */ }
    }
  };
}

/** story 4971: the press — the app's `startUpdate()` with no argument (the page never names a build or an address). `unsupported` = an older app without it; never rejects. */
export async function pressAppUpdate(bridge?: SprintableDesktop): Promise<'ok' | 'busy' | 'failed' | 'none' | 'unsupported'> {
  // the bridge the screen drew its button from when it gives one (the same object — never another instance); else the page's own
  const raw = bridge ?? rawBridge();
  if (typeof raw?.startUpdate !== 'function') return 'unsupported';
  try {
    const r = await raw.startUpdate();
    if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === true) return 'ok';
    const code = (r as { code?: unknown } | null)?.code;
    return code === 'busy' || code === 'failed' ? code : 'none';
  } catch { return 'failed'; }
}

/** tests only: forget the app's list and the shared subscription */
export function __resetDesktopAppForTest(): void {
  pushedOffer = undefined;
  offerNow = null;
  offerListeners.clear();
  stopOffer = null;
  latestRuntimes = null;
  derived = null;
  listeners.clear();
  stopBridge = null;
}
