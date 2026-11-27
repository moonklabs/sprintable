/**
 * story 5034 (C4) — the chat card catalogue's CLOSED vocabulary. An agent never sends a card's looks: it sends «a kind + a reference» and the server (never a client) writes
 * `msg_metadata.card = { kind, ref }` on the message (same rule as an event block: the server owns the words, a client value is refused 422 — story 5034 PR 2). The web draws it
 * with a part it registered itself (card-catalog.tsx) — there is no HTML in this shape, only two words.
 *
 * This file is the web's copy of the vocabulary: a kind this build does not know is NOT an error for the message (an older web meets a newer server) — `parseCardRef` says `null`
 * and the catalogue shows its «this app version cannot draw it» card.
 */
export const CARD_KINDS = ['story', 'epic', 'task', 'sprint', 'doc', 'artifact', 'hypothesis', 'evidence', 'gate', 'kanban', 'deploy', 'agent_action'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** the card kinds the shell can draw today as an entity card (the entity registry's types) — the other kinds have their own parts (a gate = the approval card · kanban · deploy = later steps) */
export const ENTITY_CARD_KINDS = ['story', 'epic', 'task', 'sprint', 'doc', 'artifact', 'hypothesis', 'evidence'] as const satisfies readonly CardKind[];
export type EntityCardKind = (typeof ENTITY_CARD_KINDS)[number];

export interface CardRef {
  kind: CardKind;
  /** the object's id (a UUID) — the one thing the agent names; everything shown is read by the server for THE VIEWER */
  ref: string;
  /** story 5034 step 4: the agent (its member id) that asked to show this object and may NOT see it (or the object does not exist — not told apart) — written by the server only; the card is then drawn as a REFUSED card, by each viewer's own rights */
  refusedFor?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCardKind(v: unknown): v is CardKind {
  return typeof v === 'string' && (CARD_KINDS as readonly string[]).includes(v);
}
export function isEntityCardKind(k: CardKind): k is EntityCardKind {
  return (ENTITY_CARD_KINDS as readonly string[]).includes(k);
}

/** what a message carries → a card reference, or `null` (absent · not an object · an unknown kind · a reference that is not a UUID). Never throws; never reads anything but the two words. */
export function parseCardRef(raw: unknown): CardRef | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { kind, ref, refused_for: refusedFor } = raw as { kind?: unknown; ref?: unknown; refused_for?: unknown };
  if (!isCardKind(kind) || typeof ref !== 'string' || !UUID_RE.test(ref)) return null;
  if (refusedFor === undefined || refusedFor === null) return { kind, ref };
  // a `refused_for` that is present but is not a UUID makes the whole thing not a card (fail closed, like the server)
  return typeof refusedFor === 'string' && UUID_RE.test(refusedFor) ? { kind, ref, refusedFor } : null;
}
