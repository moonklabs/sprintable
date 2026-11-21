// story 4977 (B3-2b) — the person's HISTORY of one chat room, in the phone app. The server keeps it as SEALED records it cannot open (server PR 5876); the phone's shell opens them (`records.open`, mobile PR 909).
// This module is the web's half: read a page of the server's rows for that room through this app's own route, hand them to the shell, and keep only what the shell answers — one closed state per row (`open` with
// its text · `stale` · `no_key` · `unverified` · `unreadable`) — and delete the person's own history of the room. Nothing of a record is ever decrypted, parsed or searched here: no envelope reaches a screen, and a
// row the shell could not open is only COUNTED. What a refusal says is a closed word of this table; the screen writes the sentence. A word the shell or the server has and this table has not is `failed`.
//
// The scope of a read is the ROOM (the server lists the person's records of that room on this computer and on any setup of the same machine); `setupId` names the computer the read goes through, and `phoneKeyId`
// the phone's key as the server lists it (`readStartableKeyed`). Pages come oldest first; the next page is asked with the cursor the shell gave back (`next_after`).

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

type Call = (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;

/** one line the shell opened: a person's instruction, or the outcome of an approval they answered */
export type OpenLine =
  | { seq: number; recordId: string; kind: 'chat_line'; writer: 'phone' | 'host'; ts: number; text: string }
  | { seq: number; recordId: string; kind: 'approval_record'; writer: 'phone' | 'host'; ts: number; decision: 'allow' | 'deny'; tool: string; summary: string };

export interface RecordsPage {
  /** the opened lines of this page, oldest first (by the writer's own time, then the server's order) */
  lines: OpenLine[];
  /** rows this page could not show, by the shell's closed word — only counted, never described */
  closed: { noKey: number; unverified: number; unreadable: number };
  /** does this phone hold any key at all? `false` + every row `no_key` is «this phone cannot open it yet», not «nothing was kept» */
  haveKey: boolean;
  /** the cursor for the next page, and whether there probably is one (the page was full) */
  nextAfter: number;
  more: boolean;
}

export type RecordsOutcome =
  | ({ kind: 'page' } & RecordsPage)
  | { kind: 'unsupported' } // an older shell (or a call it refuses)
  | { kind: 'not_paired' } // this phone is no longer paired with that computer (the server, or the shell: no pinned computer)
  | { kind: 'not_allowed' } // not this person's computer / room
  | { kind: 'room_not_found' }
  | { kind: 'key'; code: string } // the phone's own key: not registered · none · the lock-screen words
  | { kind: 'signed_out' }
  | { kind: 'unreachable' } // a network end the web cannot see: never said as «refused»
  | { kind: 'failed' };

export type DeleteOutcome = { kind: 'deleted'; count: number } | { kind: 'room_not_found' } | { kind: 'signed_out' } | { kind: 'unreachable' } | { kind: 'failed' };

export const RECORDS_PAGE = 100; // the server's largest page
/** how many rows one opening reads at most (the server lists oldest first, so the newest lines are only reached by reading on: a longer history continues with [더 불러오기]) */
export const RECORDS_OPEN_MAX_ROWS = 1000;

// the frames' own limits (the phone shell's lib/recordFrames.js): a line over them is not one the shell could have made
const TEXT_MAX = 8000;
const SUMMARY_MAX = 200;
const TOOL_MAX = 64;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY_CODES = new Set(['no_key', 'not_registered']);

/** the shell can open records at all: `shell.caps` says `records: 1` (read, never guessed from a version) */
export async function shellTakesRecords(phoneCall: Call): Promise<boolean> {
  const caps = await Promise.resolve().then(() => phoneCall('shell.caps', {})).catch(() => null); // (a call that throws at once, or answers nothing, is «no»)
  return !!caps && caps.ok === true && isObj(caps.caps) && (caps.caps as { records?: unknown }).records === 1;
}

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; detail?: { code?: string }; code?: string };
    return body.error?.code ?? body.detail?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

function fromServer(status: number, code: string): RecordsOutcome {
  if (code === 'phone_not_paired') return { kind: 'not_paired' };
  if (code === 'record_conversation_not_found') return { kind: 'room_not_found' };
  if (status === 401) return { kind: 'signed_out' };
  if (status === 403) return { kind: 'not_allowed' };
  if (status >= 500) return { kind: 'unreachable' };
  return { kind: 'failed' };
}

function fromShell(code: string | undefined): RecordsOutcome {
  if (code === 'signed_out') return { kind: 'signed_out' };
  if (code === 'bad_request') return { kind: 'unsupported' };
  if (code === 'host_not_pinned') return { kind: 'not_paired' };
  if (code !== undefined && KEY_CODES.has(code)) return { kind: 'key', code };
  return { kind: 'failed' }; // vault_unavailable · record_keys_unavailable · failed · a word this table has not
}

/** one line of the shell's answer, checked once more here (the shell already judged it: the web draws only what has this shape) */
function parseLine(v: unknown): { open: OpenLine } | { closed: 'noKey' | 'unverified' | 'unreadable' } | { skip: true } | null {
  if (!isObj(v) || typeof v.state !== 'string' || !Number.isSafeInteger(v.seq) || typeof v.record_id !== 'string') return null;
  if (v.state === 'stale') return { skip: true }; // an older version of a record that has a newer one: shown nowhere, counted nowhere
  if (v.state === 'no_key') return { closed: 'noKey' };
  if (v.state === 'unverified') return { closed: 'unverified' };
  if (v.state === 'unreadable') return { closed: 'unreadable' };
  if (v.state !== 'open' || (v.writer !== 'phone' && v.writer !== 'host') || typeof v.ts !== 'number' || !Number.isFinite(v.ts) || !isObj(v.frame)) return null;
  const writer: 'phone' | 'host' = v.writer;
  const base = { seq: v.seq as number, recordId: v.record_id, writer, ts: v.ts };
  if (v.kind === 'chat_line' && typeof v.frame.text === 'string' && v.frame.text.length <= TEXT_MAX) return { open: { ...base, kind: 'chat_line', text: v.frame.text } };
  if (v.kind === 'approval_record' && (v.frame.decision === 'allow' || v.frame.decision === 'deny') && typeof v.frame.tool === 'string' && v.frame.tool.length <= TOOL_MAX && typeof v.frame.summary === 'string' && v.frame.summary.length <= SUMMARY_MAX) {
    return { open: { ...base, kind: 'approval_record', decision: v.frame.decision, tool: v.frame.tool, summary: v.frame.summary } };
  }
  return null;
}

/**
 * Read ONE page of a room's history. `after` is the cursor the last page gave back (none = from the start). The rows the server gave go to the shell untouched; what is drawn is only what the shell answers.
 */
export async function readRecordsPage(o: { phoneCall: Call; setupId: string; conversationId: string; phoneKeyId: string; after?: number; limit?: number }): Promise<RecordsOutcome> {
  const limit = o.limit ?? RECORDS_PAGE;
  const q = new URLSearchParams({ phone_key_id: o.phoneKeyId, conversation_id: o.conversationId, limit: String(limit) });
  if (o.after !== undefined && o.after > 0) q.set('after', String(o.after));
  let res: Response;
  try { res = await fetchWithAuth(`/api/desktop/computers/${encodeURIComponent(o.setupId)}/records?${q.toString()}`); } catch { return { kind: 'unreachable' }; }
  if (!res.ok) return fromServer(res.status, await codeOf(res));
  let body: unknown;
  try { body = await res.json(); } catch { return { kind: 'failed' }; }
  if (!isObj(body) || !Array.isArray(body.records) || typeof body.next_after !== 'number' || !Number.isSafeInteger(body.next_after)) return { kind: 'failed' };
  const rows = body.records as unknown[];
  if (rows.length > limit) return { kind: 'failed' }; // a page larger than the one asked for
  const given = new Set<string>(); // what the server gave: (seq, record id) — the lines the shell answers must be exactly of these
  for (const r of rows) {
    if (!isObj(r) || !Number.isSafeInteger(r.seq) || typeof r.record_id !== 'string') return { kind: 'failed' };
    if (o.after !== undefined && (r.seq as number) <= o.after) return { kind: 'failed' }; // the server lists the rows AFTER the cursor: one at or before it is a repeat (a later page never repeats an earlier one)
    given.add(`${r.seq}:${r.record_id}`);
  }
  if (given.size !== rows.length) return { kind: 'failed' }; // the same row twice
  if (rows.length === 0) return { kind: 'page', lines: [], closed: { noKey: 0, unverified: 0, unreadable: 0 }, haveKey: true, nextAfter: body.next_after, more: false };
  let answer: PhoneAnswer;
  try { answer = await o.phoneCall('records.open', { setup_id: o.setupId, conversation_id: o.conversationId, rows, ...(o.after !== undefined && o.after > 0 ? { after: o.after } : {}) }); } catch { return { kind: 'failed' }; }
  if (!isObj(answer)) return { kind: 'failed' }; // a bridge that answers nothing (or something that is not an answer)
  if (answer.ok !== true) return answer.ok === false ? fromShell(answer.code) : { kind: 'failed' }; // only a real `true` is an answer (a truthy word is not)
  if (!Array.isArray(answer.lines) || typeof answer.have_key !== 'boolean' || typeof answer.next_after !== 'number' || !Number.isSafeInteger(answer.next_after)) return { kind: 'failed' };
  if (answer.next_after !== body.next_after) return { kind: 'failed' }; // the cursor the shell gives back is the server's last row: a cursor that stops short would make the next page overlap what was read
  if (answer.lines.length > rows.length) return { kind: 'failed' }; // a line for every row at the most — and a hostile answer is turned away BEFORE any of its lines is looked at (the checks below would refuse it too)
  const lines: OpenLine[] = [];
  const closed = { noKey: 0, unverified: 0, unreadable: 0 };
  const seen = new Set<string>();
  for (const l of answer.lines as unknown[]) {
    const p = parseLine(l);
    if (!p) return { kind: 'failed' }; // a line that is not the agreed shape: nothing of the page is drawn
    const tag = isObj(l) ? `${l.seq}:${l.record_id}` : '';
    if (!given.has(tag) || seen.has(tag)) return { kind: 'failed' }; // a line of a row the server never gave, or two lines of one row: not drawn
    seen.add(tag);
    if ('open' in p) lines.push(p.open);
    else if ('closed' in p) closed[p.closed] += 1;
  }
  lines.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return { kind: 'page', lines, closed, haveKey: answer.have_key, nextAfter: answer.next_after, more: rows.length >= limit };
}

/** the person deletes their own history of the room on the server (all of it: no record id) */
export async function deleteRoomRecords(conversationId: string): Promise<DeleteOutcome> {
  let res: Response;
  try { res = await fetchWithAuth(`/api/desktop/records?${new URLSearchParams({ conversation_id: conversationId }).toString()}`, { method: 'DELETE' }); } catch { return { kind: 'unreachable' }; }
  if (!res.ok) {
    const code = await codeOf(res);
    if (code === 'record_conversation_not_found') return { kind: 'room_not_found' };
    if (res.status === 401) return { kind: 'signed_out' };
    return res.status >= 500 ? { kind: 'unreachable' } : { kind: 'failed' };
  }
  try {
    const b = (await res.json()) as { deleted?: unknown };
    return typeof b.deleted === 'number' && Number.isSafeInteger(b.deleted) && b.deleted >= 0 ? { kind: 'deleted', count: b.deleted } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Read the history to its END, page after page (at most `RECORDS_OPEN_MAX_ROWS` rows per call): the server lists OLDEST first, and what a person opens this for is usually the newest lines, so the sheet reads on until the
 * last page and shows the end of it. A history longer than the limit comes back with `more: true` and the cursor — the next call (`after`) goes on from there. The first page that cannot be read ends the read with its
 * outcome (nothing half-drawn); `closed` counts add up and `haveKey` is false only when no page said otherwise.
 */
export async function readRecordsAll(o: { phoneCall: Call; setupId: string; conversationId: string; phoneKeyId: string; after?: number; maxRows?: number }): Promise<RecordsOutcome> {
  const max = o.maxRows ?? RECORDS_OPEN_MAX_ROWS;
  const total: RecordsPage = { lines: [], closed: { noKey: 0, unverified: 0, unreadable: 0 }, haveKey: false, nextAfter: o.after ?? 0, more: false };
  let read = 0;
  let after = o.after;
  for (;;) {
    const r = await readRecordsPage({ phoneCall: o.phoneCall, setupId: o.setupId, conversationId: o.conversationId, phoneKeyId: o.phoneKeyId, ...(after !== undefined ? { after } : {}) });
    if (r.kind !== 'page') return r;
    total.lines.push(...r.lines);
    total.closed.noKey += r.closed.noKey; total.closed.unverified += r.closed.unverified; total.closed.unreadable += r.closed.unreadable;
    total.haveKey = total.haveKey || r.haveKey;
    total.nextAfter = Math.max(total.nextAfter, r.nextAfter);
    read += RECORDS_PAGE;
    if (!r.more) return { kind: 'page', ...total, more: false };
    if (r.nextAfter <= (after ?? 0)) return { kind: 'failed' }; // a full page that did not move the cursor: the server is not answering as agreed — never loop on it
    after = r.nextAfter;
    if (read >= max) return { kind: 'page', ...total, more: true };
  }
}
