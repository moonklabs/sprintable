/**
 * story 4981 (연결 ③ · PR 4) — the agent usage sheet's data: `GET /api/agents/{id}/desktop-usage` → what the computer's host last said of its CLIs' limits.
 * The server answers in closed words and whole numbers; this module keeps ONLY what has that shape (a row that does not is left out), and turns times into the buckets the screen
 * words — the same ones as the strip's «마지막으로 본 지 N분 전» (4979): under a minute → «방금 전», under an hour → minutes, under a day → hours, else days.
 * The numbers are shown, never decided by: nothing here gates or switches anything.
 */
export type UsageKind = 'five_hour' | 'seven_day' | 'other';
export type UsageRuntime = 'claude' | 'codex';
/** the reasons a CLI has no numbers to show — a closed list, each with its own sentence (the server's words) */
export type UsageWhy = 'api_key' | 'not_read';

export interface UsageWindow { kind: UsageKind; minutes: number | null; usedPercent: number; resetsAt: string | null }
export interface UsageRow {
  runtime: UsageRuntime;
  account: string;
  /** story 4986: the name the person gave this account on the computer (display text) — null when none, or when the server's word is not a name this rule allows */
  label: string | null;
  state: 'windows' | 'unavailable';
  why: UsageWhy | null;
  windows: UsageWindow[];
  seenAt: string;
}
export interface UsageView { remoteControl: boolean; deviceName: string | null; connected: boolean; hasComputer: boolean; rows: UsageRow[] }

export type UsageState = { kind: 'ok'; view: UsageView } | { kind: 'failed' } | { kind: 'gone' };
/** the network (it reads one agent's usage — the caller owns the URL and the auth) and the clock */
export interface UsageDeps { fetch: (agentId: string) => Promise<Response>; now: () => number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function parseWindow(raw: unknown): UsageWindow | null {
  if (!isObj(raw)) return null;
  const { kind, minutes, used_percent: pct, resets_at: resets } = raw;
  if (kind !== 'five_hour' && kind !== 'seven_day' && kind !== 'other') return null;
  if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100) return null;
  const m = typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 ? minutes : null;
  return { kind, minutes: m, usedPercent: pct, resetsAt: isTime(resets) ? resets : null };
}

export const LABEL_MAX = 40;
/** the characters a name may not have — the SAME table as the server's (backend `desktop_usage.label_problem`) and the host's: controls · format (zero-width, word joiner, soft hyphen, BOM, direction overrides) · private use · line/paragraph separators,
 *  slash and backslash and the characters that LOOK like one, and no space at an end. The server already judged it; the page judges it again (a row someone wrote by hand) and shows no name rather than a bad one. */
const LABEL_BAD_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\\/\u2044\u2215\u2216\u29f5\u29f8\u29f9\ufe68\uff0f\uff3c\u2571\u2572\u27cb\u27cd]/u;
/** a name the page may draw, or null */
export function safeLabel(v: unknown): string | null {
  if (typeof v !== 'string' || v === '' || [...v].length > LABEL_MAX || v !== v.trim() || LABEL_BAD_CHAR.test(v)) return null;
  return v;
}

function parseRow(raw: unknown): UsageRow | null {
  if (!isObj(raw)) return null;
  const { runtime, account, state, why, windows, seen_at: seen } = raw;
  const label = safeLabel(raw.label);
  if (runtime !== 'claude' && runtime !== 'codex') return null;
  if (typeof account !== 'string' || !/^[a-z0-9]{8,32}$/.test(account) || !isTime(seen)) return null;
  if (state === 'windows') {
    if (!Array.isArray(windows) || windows.length < 1 || windows.length > 4) return null;
    const ws = windows.map(parseWindow);
    if (ws.some((w) => w === null)) return null;
    return { runtime, account, label, state, why: null, windows: ws as UsageWindow[], seenAt: seen };
  }
  if (state === 'unavailable' && (why === 'api_key' || why === 'not_read')) return { runtime, account, label, state, why, windows: [], seenAt: seen };
  return null;
}

/** the server's answer, kept only as far as it has the shape the sheet draws (a row that has not is left out — never drawn half) */
export function parseUsage(raw: unknown): UsageView | null {
  if (!isObj(raw) || typeof raw.remote_control !== 'boolean' || typeof raw.connected !== 'boolean' || !Array.isArray(raw.usage)) return null;
  const rows = raw.usage.map(parseRow).filter((r): r is UsageRow => r !== null);
  return {
    remoteControl: raw.remote_control,
    deviceName: typeof raw.device_name === 'string' && raw.device_name.length > 0 ? raw.device_name : null,
    connected: raw.connected,
    hasComputer: typeof raw.setup_id === 'string' && raw.setup_id.length > 0,
    rows,
  };
}

export async function loadUsage(agentId: string, deps: UsageDeps): Promise<UsageState> {
  try {
    const res = await deps.fetch(agentId);
    if (res.status === 404 || res.status === 403) return { kind: 'gone' };
    if (!res.ok) return { kind: 'failed' };
    const view = parseUsage(await res.json());
    return view ? { kind: 'ok', view } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type Ago = { unit: 'now' } | { unit: 'min' | 'hour' | 'day'; n: number };

/** how long ago (the strip's own buckets and rule — `lastSeenLine`): under a minute → now · under an hour → minutes · under a day → hours · else days; a time that cannot be read (none · not a date · more than a minute in the future) says nothing → `null` */
export function agoOf(iso: string | null | undefined, now: number): Ago | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const ms = now - at;
  if (ms < -60_000) return null;
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return { unit: 'now' };
  if (min < 60) return { unit: 'min', n: min };
  if (min < 24 * 60) return { unit: 'hour', n: Math.floor(min / 60) };
  return { unit: 'day', n: Math.floor(min / (24 * 60)) };
}

export type Until = { unit: 'passed' } | { unit: 'min' | 'hour' | 'day'; n: number };

/** how long until a window resets: past → «passed» · under an hour → minutes (at least 1) · under a day → hours (nearest) · else days (nearest). `null` = no time given */
export function untilOf(iso: string | null | undefined, now: number): Until | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return { unit: 'passed' };
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return { unit: 'min', n: min };
  if (min < 24 * 60) return { unit: 'hour', n: Math.max(1, Math.round(min / 60)) };
  return { unit: 'day', n: Math.max(1, Math.round(min / (24 * 60))) };
}

/** a window's length as the screen names it: the two Claude words, or the minutes the CLI gave (minutes · hours · days) */
export type WindowName = { key: 'five_hour' | 'seven_day' | 'unknown' } | { key: 'min' | 'hour' | 'day'; n: number };
export function windowName(w: Pick<UsageWindow, 'kind' | 'minutes'>): WindowName {
  if (w.kind === 'five_hour') return { key: 'five_hour' };
  if (w.kind === 'seven_day') return { key: 'seven_day' };
  const m = w.minutes;
  if (m === null) return { key: 'unknown' };
  if (m < 60) return { key: 'min', n: m };
  if (m < 24 * 60) return { key: 'hour', n: Math.round(m / 60) };
  return { key: 'day', n: Math.round(m / (24 * 60)) };
}

/** which of a CLI's accounts a row is, when there are several (1-based, in the server's stable order) — `null` when the CLI has one */
export function accountOrdinal(rows: readonly UsageRow[], row: UsageRow): number | null {
  const same = rows.filter((r) => r.runtime === row.runtime);
  return same.length > 1 ? same.indexOf(row) + 1 : null;
}
