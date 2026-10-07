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
  tool: string;
  /** story 4542: the server's name for the tool by the one rule (backend app/services/tool-names.json) — what this card shows; a row
   *  from an older server has none (the value is shown as it is) */
  runtime?: string;
  tool_name?: { ko: string; en: string };
  summary: string;
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
}

/** The line in the button place — one, in the spec's order: the window passed · the computer gone quiet · no paired phone · the phone. */
export type PermissionLine = 'expired' | 'unknown' | 'noPairedPhone' | 'answerOnPhone';

export function permissionLine(r: PermissionRequest): PermissionLine {
  if (r.state === 'expired') return 'expired';
  if (!r.device_reachable) return 'unknown';
  if (r.recipient_reason === 'no_paired_phone') return 'noPairedPhone';
  return 'answerOnPhone';
}

/** Still waiting for someone: pending, or past its window within the last hour (the card says so, then leaves — a window is ≤1h). */
export function stillShown(r: PermissionRequest, now: number): boolean {
  if (r.state === 'pending') return true;
  return r.state === 'expired' && now - Date.parse(r.expires_at) <= 60 * 60 * 1000;
}

/** «{n}분째 기다림» — whole minutes since the request came; not shown while the computer's state is unknown (명세 B-2). */
export function waitedMinutes(r: PermissionRequest, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(r.created_at)) / 60000));
}

/** story 4542: the tool as this card names it — the server's name in this language, else the value as it is (never guessed here) */
export function shownToolName(r: Pick<PermissionRequest, 'tool' | 'tool_name'>, locale: string): string {
  const n = r.tool_name;
  return (n && (locale === 'en' ? n.en : n.ko)) || r.tool;
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
