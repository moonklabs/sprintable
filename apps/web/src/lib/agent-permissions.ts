/**
 * story #4533 (E-DESKTOP-2 B-2) — an agent's permission request as the web shows it (contract 02d2cf71 §9 ② · 명세 모음 B-2).
 * The web only looks: a browser holds no device key to sign with (v1 · 설계 §6-3), so the button place always holds one line.
 */
export interface PermissionRequest {
  id: string;
  request_id: string;
  setup_id: string;
  device_name: string | null;
  agent_member_id: string;
  agent_name: string | null;
  role: string | null;
  /** story #4590: null on a terminal-only question whose tool the daemon did not read */
  tool: string | null;
  /** story 4542: the server's name for the tool by the one rule (backend app/services/tool-names.json) — what this card shows; a row
   *  from an older server has none (the value is shown as it is) · story #4590: null when no tool was read */
  runtime?: string;
  tool_name?: { ko: string; en: string } | null;
  /** story #4590: null on a terminal-only question with no detail read */
  summary: string | null;
  /** story #4590: only that computer's terminal answers it — no buttons, its own line (an older server sends none) */
  terminal_only?: boolean;
  masked: boolean;
  truncated: boolean;
  workdir: string | null;
  created_at: string;
  expires_at: string;
  state: 'pending' | 'answered' | 'withdrawn' | 'expired' | 'rejected';
  answered_by_name: string | null;
  decision: 'allow' | 'deny' | null;
  device_reachable: boolean;
  recipient_reason: 'paired' | 'no_paired_phone';
  answerable: boolean;
  /** story 4532: what the phone signs — its own shell reads them from this list (the web never passes them to the phone) ·
   *  null unless `answerable` (an unsalted hash of the input is carried no longer than its answer needs) */
  session_key: string | null;
  input_hash: string | null;
  /** story #4580 AC2: a network question's second answer carries the host (the daemon's value from Claude's own hook text) */
  stage?: 'ask' | 'confirm';
  host?: string | null;
  /** story #4580 AC2 F2: the daemon could not read the host from Claude's own text — the request ended, nothing allowed */
  host_unread?: boolean;
}

/** The line in the button place — one, in the spec's order: the window passed · the computer gone quiet · only its terminal answers ·
 *  no paired phone · the phone. story #4590 (Yuna §1): a terminal-only question cannot be answered by a phone, paired or not — so its
 *  line comes before the two phone lines, after the facts of time and state. */
export type PermissionLine = 'expired' | 'unknown' | 'terminalOnly' | 'noPairedPhone' | 'answerOnPhone';

export function permissionLine(r: PermissionRequest): PermissionLine {
  if (r.state === 'expired') return 'expired';
  if (!r.device_reachable) return 'unknown';
  if (r.terminal_only) return 'terminalOnly';
  if (r.recipient_reason === 'no_paired_phone') return 'noPairedPhone';
  return 'answerOnPhone';
}

/** Still waiting for someone: pending, or past its window within the last hour (the card says so, then leaves — a window is ≤1h). */
export function stillShown(r: PermissionRequest, now: number): boolean {
  if (r.state === 'pending') return true;
  // story #4580 AC2 F2: a network question whose host could not be read stays with its line for a while, as an expired one
  if (r.state === 'withdrawn' && r.host_unread) return now - Date.parse(r.created_at) <= 60 * 60 * 1000;
  return r.state === 'expired' && now - Date.parse(r.expires_at) <= 60 * 60 * 1000;
}

/** story #4610 (Yuna `time-words.md` §1 · the desktop board's relativeTime steps and bounds): how long ago, as the card head says it —
 *  under 60 s «방금», then whole minutes · hours · days, one unit, rounded down. The one rule both keys (`waited` · `asked`) use.
 *  The unit is one letter (s · m · h · d — Yuna's now · min · hour · day): a select case is written into the ko value, and the ko guard
 *  (verify-no-ascii-token-in-ko-value) reads a lowercase word of 3+ letters there as untranslated English. The words shown are hers. */
export function ageParts(ms: number): { unit: 's' | 'm' | 'h' | 'd'; n: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return { unit: 's', n: 0 };
  if (s < 3600) return { unit: 'm', n: Math.floor(s / 60) };
  if (s < 86400) return { unit: 'h', n: Math.floor(s / 3600) };
  return { unit: 'd', n: Math.floor(s / 86400) };
}

/** the request's age at `now` (명세 B-2: the waiting chip is not shown while the computer's state is unknown) */
export function requestAge(r: PermissionRequest, now: number): ReturnType<typeof ageParts> {
  return ageParts(now - Date.parse(r.created_at));
}

/** story 4542: the tool as this card names it — the server's name in this language, else the value as it is (never guessed here) ·
 *  story #4590: null when the daemon did not read a tool (a terminal-only question) — the card says where to see it instead */
export function shownToolName(r: Pick<PermissionRequest, 'tool' | 'tool_name'>, locale: string): string | null {
  const n = r.tool_name;
  return (n && (locale === 'en' ? n.en : n.ko)) || r.tool || null;
}

/** story 4542 (Yuna · Kadir ④): «{agent} · {computer}» — the computer not again when the agent's name already ends in exactly
 *  « · {computer}» (the same rule as the phone's sheet and the push) */
export function agentOnDevice(agent: string | null | undefined, device: string | null | undefined): string {
  const a = (agent ?? '').trim();
  const d = (device ?? '').trim();
  if (!d) return a;
  if (!a) return d;
  return a.endsWith(` · ${d}`) ? a : `${a} · ${d}`;
}
