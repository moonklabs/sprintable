// story #4733 (S4b) — the body keys the web forwards to POST /api/v2/desktop/setups/{id}/clock (the phone's signed press on a computer's sessions).
// Kept out of the route file: a Next.js app route may export only its HTTP handlers and route config names.
// `agent_member_id` is present only for a press on ONE agent (the signature covers it); no text · name · path ever goes from here.
export const DESKTOP_CLOCK_KEYS = ['action', 'idempotency_key', 'signed', 'phone_key_id', 'agent_member_id'] as const;
export const DESKTOP_CLOCK_ACTIONS = ['out_open', 'out_submit', 'out_cancel', 'in'] as const;
