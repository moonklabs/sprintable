// story #4714 — the five body keys the web forwards to POST /api/v2/agents/{id}/desktop-start (contract 02d2cf71 §14 ②).
// Kept out of the route file: a Next.js app route may export only its HTTP handlers and route config names.
export const DESKTOP_START_KEYS = ['setup_id', 'project_id', 'signed', 'phone_key_id', 'idempotency_key'] as const;
