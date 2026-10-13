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
  /** the OS folder chooser: a folder inside home, or null (canceled · refused — the reason comes back from setProjectFolder) */
  pickFolder(): Promise<string | null>;
  /** start that agent on this computer: the app opens its setup page (with `agent=` in the fragment) — no link round trip */
  startHere(a: { agentId: string }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** keep a project's folder on this computer — `path` must be one pickFolder returned in this page (else `problem: 'not_picked'`);
   *  the app checks the folder again (inside home · not its own folder). A page never names a folder itself. */
  setProjectFolder(a: { projectId: string; path: string }): Promise<{ ok: true } | { problem: string }>;
}

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
  return d as SprintableDesktop;
}

/** this page inside the desktop app, or undefined (a browser · the server) */
export function desktopApp(): SprintableDesktop | undefined {
  if (typeof window === 'undefined') return undefined;
  return desktopAppOf((window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop);
}
