// story 4887 (UI-4 P4-a) — which messages of the room body belong together: one run of the SAME sender with no longer a gap than five minutes between neighbours.
// The run shows the sender's avatar · name · time ONCE (its first message); the others only continue it. (The day groups are made before this — a run never crosses a day line.)
// A pure function on purpose: the rule is the thing under test, not the markup.

/** the longest gap between two neighbouring messages of one sender that still keeps them in one run */
export const RUN_GAP_MS = 5 * 60 * 1000;

export interface RunMessage {
  created_by: string;
  created_at: string;
}

/** does `message` continue the run of `previous` (the message right before it in the same day group)? */
export function continuesRun(previous: RunMessage | undefined, message: RunMessage): boolean {
  if (!previous || previous.created_by !== message.created_by) return false;
  const gap = Date.parse(message.created_at) - Date.parse(previous.created_at);
  // an unreadable time cannot prove «within five minutes» — a new run is the safe side (the name and time show again); a message that is older than its neighbour is not a continuation either
  return Number.isFinite(gap) && gap >= 0 && gap <= RUN_GAP_MS;
}
