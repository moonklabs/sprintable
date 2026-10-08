// story #4534 — a stop or an instruction for an agent at work, from inside the phone app (contract 48616ee0 v0.3 · 02d2cf71 §11 ② ·
// spec b0713c54 B-3).
//
// The web only says which agent and what (and, for an instruction, the text and this conversation). The phone app's shell reads the
// session (and that this conversation is the person's and the agent's) from the server itself, shows an instruction on its own sheet,
// asks the person on the OS prompt and signs; the web then posts the shell's values — its `session_key`, and the text it showed
// (cleaned the daemon's way) — and follows the command to its end. Every way it ends is one outcome kind; the strip turns it into one
// line (messages `chats.agentSession.command.*`). An instruction is never lost: a turn that had ended gets it as a message instead.
// «Not known» is never said as «not sent» (Kadir 4955 1st line): once the post may have reached the server, an end the web cannot
// see is `unknown` — no message instead, and the next press follows THAT command (the same idempotency key · the same signed body ·
// no new signature), so nothing goes in twice.

import { fetchWithAuth } from '@/lib/db/client';
import { hiddenCharsChange } from './instruction-text';
import type { PhoneAnswer } from './phone-bridge';

export type CommandOutcome =
  | { kind: 'stopped' } // the daemon interrupted the turn — the session lives on
  | { kind: 'already_stopped' } // nothing was working
  | { kind: 'sent_now' } // the instruction went into the turn
  | { kind: 'sent_after_step' } // pasted — it goes in as soon as the step the agent is on ends (PO 10:20Z · Yuna)
  | { kind: 'sent_as_message' } // the turn had ended — sent as a message instead (it goes in when its turn comes)
  | { kind: 'sent_as_message_not_now' } // this session could not take it into the turn (the daemon said so) — sent as a message instead
  | { kind: 'too_long' } // over 400 code points — the sheet stops it first; the server refuses it again
  // story 4633 (contract v0.4 §3 · web): the daemon refused it because the text holds invisible characters — refused, never sent as a message
  | { kind: 'hidden_text' }
  | { kind: 'unreachable' } // the server refused before making it (409 device_unreachable) — certainly not sent
  | { kind: 'unknown'; pending: Pending } // it may have gone (the post's answer was lost · no end in two minutes) — follow it, never redo it
  | { kind: 'remote_off' } // the organization turned remote control off
  | { kind: 'conversation_not_found' } // the shell could not confirm this conversation is the person's and the agent's
  | { kind: 'not_paired' } // 409 phone_not_paired
  | { kind: 'cancelled' } // the person said no on the sheet or the OS prompt
  | { kind: 'biometric_required' }
  | { kind: 'no_screen_lock' }
  | { kind: 'key_invalidated' }
  | { kind: 'not_registered' }
  | { kind: 'signed_out' }
  // story #4599 (contract v1.13.2 · PO 14:08Z · 14:18Z): the whole session ended (end_session done) — no line of its own, the strip shows
  // the ended state · a stop refused because a macOS window holds the turn (the server's or the daemon's closed reason) — only an end goes
  | { kind: 'ended' }
  | { kind: 'system_wait_end_only' }
  // story #4599 (Yuna · PO 19:47Z): [세션 끝내기] signed nothing — the window was answered on that Mac first, the session works again
  // (the shell's `not_held`). Never «failed»: «다시 눌러 주세요» would press [멈춤], the button there now, and stop a working turn
  | { kind: 'not_held' }
  | { kind: 'failed' };

export type CommandInput =
  | { agentId: string; kind: 'stop_session' }
  | { agentId: string; kind: 'end_session' } // story #4599: [세션 끝내기] — the shell signs this kind, so what was signed is what happens
  | { agentId: string; kind: 'send_prompt'; text: string; conversationId: string };

export type Verb = 'stop' | 'send' | 'end';
/** a command the web posted (or tried to): what [결과 확인] follows again — the same key and body, its id once known */
export interface Pending { verb: Verb; key: string; body: Record<string, unknown>; commandId?: string }

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;
export interface CommandDeps {
  phoneCall: Call;
  /** a message into this conversation (the instruction kept when the turn had ended) — true when it went */
  sendMessage: (text: string) => Promise<boolean>;
  /** a fresh idempotency key per press (the server keys the command on it) */
  newKey: () => string;
  wait?: (ms: number) => Promise<void>;
  /** the wall clock (ms) — the two minutes are counted on it from the command's post, not as a number of polls */
  now?: () => number;
  pollMs?: number;
  pollMaxMs?: number;
}

/** contract 48616ee0 §3: the web follows the command every 1.5 s, two minutes at most */
export const COMMAND_POLL_MS = 1_500;
export const COMMAND_POLL_MAX_MS = 120_000;

type PlainOutcome = Exclude<CommandOutcome, { kind: 'unknown' }>;
const KEY_REFUSALS: Record<string, PlainOutcome['kind']> = {
  cancelled: 'cancelled',
  biometric_required: 'biometric_required',
  no_screen_lock: 'no_screen_lock',
  key_invalidated: 'key_invalidated',
  not_registered: 'not_registered',
  signed_out: 'signed_out',
  remote_control_off: 'remote_off',
  conversation_not_found: 'conversation_not_found',
  not_held: 'not_held', // story #4599: an end refused by the shell — no longer held by a macOS window (phoneCalls.js)
};

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; code?: string };
    return body.error?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

export async function commandOnPhone(input: CommandInput, deps: CommandDeps): Promise<CommandOutcome> {
  const prompt = input.kind === 'send_prompt';
  // the turn had ended: an instruction goes in as a message (the person's words are never dropped) · a stop had nothing to stop
  const notWorking = async (text: string): Promise<CommandOutcome> => {
    if (!prompt) return { kind: 'already_stopped' };
    if (hiddenCharsChange(text)) return { kind: 'hidden_text' }; // story 4633: a text the daemon would change never goes into the chat as a message
    return (await deps.sendMessage(text).catch(() => false)) ? { kind: 'sent_as_message' } : { kind: 'failed' };
  };

  const signed = await deps.phoneCall('command.sign', prompt
    ? { agent_member_id: input.agentId, kind: 'send_prompt', text: input.text, conversation_id: input.conversationId }
    : { agent_member_id: input.agentId, kind: input.kind });
  if (!signed.ok) {
    const code = signed.code ?? '';
    if (code === 'not_working' || code === 'no_session') return notWorking(prompt ? input.text : '');
    return { kind: KEY_REFUSALS[code] ?? 'failed' } as PlainOutcome;
  }
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string' || typeof signed.session_key !== 'string') return { kind: 'failed' };
  // the text the shell showed and signed (cleaned) — never the one typed here
  const text = prompt && typeof signed.text === 'string' ? signed.text : undefined;
  if (prompt && text === undefined) return { kind: 'failed' };

  const pending: Pending = {
    verb: prompt ? 'send' : input.kind === 'end_session' ? 'end' : 'stop',
    key: deps.newKey(),
    body: {
      // story #4599 (PO 14:25Z · Min 387): the kind the shell signed is the kind posted — an end is never posted as a stop, nor the
      // other way (the daemon checks the signed kind against the command's); a shell from before says none → what was asked
      kind: typeof signed.kind === 'string' ? signed.kind : input.kind,
      session_key: signed.session_key,
      signed: signed.signed,
      phone_key_id: signed.phone_key_id,
      ...(prompt ? { text, conversation_id: input.conversationId } : {}),
    },
  };
  return post(input.agentId, pending, deps);
}

/** [결과 확인]: the same command again — its id when known (follow it), else the same post (same key: the server gives back the
 *  command it made, if it made one) · never a new signature */
export async function checkCommand(agentId: string, pending: Pending, deps: CommandDeps): Promise<CommandOutcome> {
  return pending.commandId ? follow(agentId, pending, deps) : post(agentId, pending, deps);
}

async function post(agentId: string, pending: Pending, deps: CommandDeps): Promise<CommandOutcome> {
  const prompt = pending.verb === 'send';
  const text = typeof pending.body.text === 'string' ? pending.body.text : '';
  const notWorking = async (): Promise<CommandOutcome> => {
    if (!prompt) return { kind: 'already_stopped' };
    if (hiddenCharsChange(text)) return { kind: 'hidden_text' }; // story 4633: a text the daemon would change never goes into the chat as a message
    return (await deps.sendMessage(text).catch(() => false)) ? { kind: 'sent_as_message' } : { kind: 'failed' };
  };
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/agents/${agentId}/desktop-commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pending.body, idempotency_key: pending.key }),
    });
  } catch {
    return { kind: 'unknown', pending }; // the post may have reached the server — its answer was lost
  }
  if (!res.ok) {
    // Kadir 4955 (5981640479): any 5xx may have come after the command was made (the backend's INTERNAL_ERROR envelope · a proxy
    // timeout · a code or none) — never an end: kept, [결과 확인] follows it with the same key
    if (res.status >= 500) return { kind: 'unknown', pending };
    const code = await codeOf(res);
    // a refusal the server named (4xx): nothing was made (the same key would have given back the first command — server rule)
    if (code === 'session_not_working' || code === 'session_not_found') return notWorking();
    if (code === 'device_unreachable') return { kind: 'unreachable' };
    // story #4599 (PO 14:18Z): a macOS window holds the turn — the stop was refused before anything was made; only an end goes
    if (code === 'system_wait_end_only') return { kind: 'system_wait_end_only' };
    if (code === 'instruct_too_long') return { kind: 'too_long' };
    if (code === 'instruct_hidden_text') return { kind: 'hidden_text' }; // story 4633: refused before anything was made — never a message
    if (code === 'remote_control_off') return { kind: 'remote_off' };
    if (code === 'conversation_not_found') return { kind: 'conversation_not_found' };
    if (code === 'phone_not_paired') return { kind: 'not_paired' };
    return { kind: 'failed' }; // another 4xx: refused before anything was made
  }
  let made: { command_id?: string; state?: string };
  try { made = (await res.json()) as typeof made; } catch { return { kind: 'unknown', pending }; }
  if (made.state === 'already_stopped') return { kind: 'already_stopped' };
  if (typeof made.command_id !== 'string') return { kind: 'unknown', pending };
  return follow(agentId, { ...pending, commandId: made.command_id }, deps);
}

// follow it: done · after_step · the daemon's «the turn had ended» · any other end · two minutes on the wall clock without an end
async function follow(agentId: string, pending: Pending, deps: CommandDeps): Promise<CommandOutcome> {
  const prompt = pending.verb === 'send';
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const every = deps.pollMs ?? COMMAND_POLL_MS;
  const deadline = now() + (deps.pollMaxMs ?? COMMAND_POLL_MAX_MS);
  while (now() < deadline) {
    await wait(every);
    let r: { state?: string; result_code?: string | null };
    try {
      const got = await fetchWithAuth(`/api/agents/${agentId}/desktop-commands/${pending.commandId}`);
      if (!got.ok) continue; // a read that failed is not an end — ask again
      r = (await got.json()) as typeof r;
    } catch {
      continue;
    }
    if (r.state === 'done') return prompt ? { kind: r.result_code === 'after_step' ? 'sent_after_step' : 'sent_now' } : pending.verb === 'end' ? { kind: 'ended' } : { kind: 'stopped' };
    // story #4599 (Mirko 385): the daemon found a macOS window holding the turn when the stop reached it — the same closed reason
    if (r.state === 'rejected' && r.result_code === 'system_wait_end_only') return { kind: 'system_wait_end_only' };
    // the daemon found the turn ended: it never put it in — the instruction becomes a message (nothing went in twice)
    if (r.state === 'rejected' && r.result_code === 'session_not_working') {
      if (!prompt) return { kind: 'already_stopped' };
      const text = typeof pending.body.text === 'string' ? pending.body.text : '';
      if (hiddenCharsChange(text)) return { kind: 'hidden_text' }; // story 4633: a text the daemon would change never goes into the chat as a message
      return (await deps.sendMessage(text).catch(() => false)) ? { kind: 'sent_as_message' } : { kind: 'failed' };
    }
    // story #4534 (PO 06:20Z · Kadir 06:31Z (a)): the daemon could not put it into this session's turn (refused before anything was
    // pasted) — it goes in as a message, never dropped; its own line says why
    // story 4633 (contract v0.4 §3): the daemon refused the signed text for its hidden characters — its own line; no «send as a message»
    // route (the same words would reach the chat unchecked)
    if (prompt && r.state === 'rejected' && r.result_code === 'instruct_hidden_text') return { kind: 'hidden_text' };
    if (prompt && r.state === 'rejected' && r.result_code === 'instruct_not_now') {
      const text = typeof pending.body.text === 'string' ? pending.body.text : '';
      if (hiddenCharsChange(text)) return { kind: 'hidden_text' }; // story 4633: a text the daemon would change never goes into the chat as a message
      return (await deps.sendMessage(text).catch(() => false)) ? { kind: 'sent_as_message_not_now' } : { kind: 'failed' };
    }
    if (r.state === 'rejected' || r.state === 'failed') return { kind: 'failed' };
  }
  return { kind: 'unknown', pending };
}
