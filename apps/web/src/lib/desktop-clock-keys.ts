// story #4733 (S4b) — the body keys the web forwards to POST /api/v2/desktop/setups/{id}/clock (the phone's signed press on a computer's sessions).
// Kept out of the route file: a Next.js app route may export only its HTTP handlers and route config names.
// `agent_member_id` is present only for a press on ONE agent (the signature covers it); no name · path ever goes from here. The one text that does: `edit` (S5 · P2) — the fields a
// person typed into ONE agent's draft, only with the action `out_edit` (the signature holds a hash of exactly them; the server carries them and logs nothing).
export const DESKTOP_CLOCK_KEYS = ['action', 'idempotency_key', 'signed', 'phone_key_id', 'agent_member_id', 'edit'] as const;
export const DESKTOP_CLOCK_ACTIONS = ['out_open', 'out_submit', 'out_cancel', 'in', 'out_edit'] as const;
/** the keys of an `edit` the web forwards: the revision the page read and the three text fields — nothing else goes through */
export const DESKTOP_CLOCK_EDIT_KEYS = ['base_rev', 'done', 'plan', 'blockers'] as const;
