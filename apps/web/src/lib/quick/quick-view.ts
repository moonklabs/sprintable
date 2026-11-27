// story 5047 (C14 · PO 11-27): what the quick-ask page is given by the Mac app. The STATE lives in the app (desktop-electron/src/quick-ask.ts — it decides when the window closes);
// this page draws it and reports what the person did. The page reads the state defensively: anything that is not the shape below is dropped and the page keeps what it last drew.

export type QuickTargetView = { kind: 'agent' | 'channel'; id: string; name: string };

export type QuickAttachView =
  | { kind: 'off' }
  | { kind: 'denied'; permission: string }
  | { kind: 'capturing' }
  | { kind: 'ready'; preview: { dataUrl: string; label: string } };

export type QuickPhase = 'empty' | 'picking' | 'sending' | 'failed' | 'login' | 'discard';
export type QuickFailure = 'login' | 'rejected' | 'server' | 'offline';

export interface QuickViewState {
  open: boolean;
  phase: QuickPhase;
  text: string;
  target: QuickTargetView | null;
  pickQuery: string;
  attach: QuickAttachView;
  failure: QuickFailure | null;
}

const PHASES: readonly string[] = ['empty', 'picking', 'sending', 'failed', 'login', 'discard'];
const FAILURES: readonly string[] = ['login', 'rejected', 'server', 'offline'];
const isStr = (v: unknown): v is string => typeof v === 'string';

function parseTarget(v: unknown): QuickTargetView | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  return (t.kind === 'agent' || t.kind === 'channel') && isStr(t.id) && t.id !== '' && isStr(t.name) ? { kind: t.kind, id: t.id, name: t.name } : null;
}

function parseAttach(v: unknown): QuickAttachView | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  if (a.kind === 'off' || a.kind === 'capturing') return { kind: a.kind };
  if (a.kind === 'denied') return { kind: 'denied', permission: isStr(a.permission) ? a.permission : 'unknown' };
  if (a.kind === 'ready' && typeof a.preview === 'object' && a.preview !== null) {
    const p = a.preview as Record<string, unknown>;
    // only an image the app captured is drawn: a data: image address (the page never loads another address into the window)
    if (isStr(p.dataUrl) && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.dataUrl) && isStr(p.label)) return { kind: 'ready', preview: { dataUrl: p.dataUrl, label: p.label } };
  }
  return null;
}

export function parseQuickState(raw: unknown): QuickViewState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.open !== 'boolean' || !isStr(r.phase) || !PHASES.includes(r.phase) || !isStr(r.text) || !isStr(r.pickQuery)) return null;
  const attach = parseAttach(r.attach);
  if (!attach) return null;
  const target = r.target === null ? null : parseTarget(r.target);
  if (r.target !== null && target === null) return null;
  const failure = r.failure === null ? null : isStr(r.failure) && FAILURES.includes(r.failure) ? (r.failure as QuickFailure) : undefined;
  if (failure === undefined) return null;
  return { open: r.open, phase: r.phase as QuickPhase, text: r.text, target, pickQuery: r.pickQuery, attach, failure };
}

/** the bridge the app's preload gives this page (desktop-electron/src/quick-ask-preload.ts); absent in a normal browser tab */
export interface QuickBridge {
  onState(fn: (state: unknown) => void): () => void;
  onPost(fn: (post: unknown) => void): () => void;
  event(e: unknown): Promise<void>;
  resize(height: number): void;
  ready(): void;
}

export function quickBridge(): QuickBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { quickAsk?: Partial<QuickBridge> }).quickAsk;
  return b && typeof b.onState === 'function' && typeof b.onPost === 'function' && typeof b.event === 'function' && typeof b.resize === 'function' && typeof b.ready === 'function' ? (b as QuickBridge) : null;
}

/** what the app asks the page to send */
export interface QuickPost { text: string; target: QuickTargetView; picture: string | null }

export function parsePost(raw: unknown): QuickPost | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const target = parseTarget(r.target);
  if (!isStr(r.text) || !target) return null;
  if (r.picture !== null && !(isStr(r.picture) && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(r.picture))) return null;
  return { text: r.text, target, picture: r.picture as string | null };
}
