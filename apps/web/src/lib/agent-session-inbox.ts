/**
 * story 4684 (Yuna `ux1-copy-1013.md` §L ② ③) — why THIS computer receives no new work for the agent, as the server tells it (`inbox` on
 * GET /api/agents/{id}/desktop-session): the app board's own stop words, only while the computer is heard and the session lives. The phone and the
 * web strip say two of them — another place is receiving (the second install was refused) and another place TOOK the agent over (this computer was
 * displaced); the other two (the key is refused · the waiting list is full) have no words in the strip yet → no line, never a guessed one.
 */
export interface SessionInbox {
  stream?: string | null;
}

export type InboxStop = 'other_receiver' | 'taken_over';

/** the stop the strip draws a line for, or null — `stopped_auth` · `stopped_inbox_full` and any word this page does not know say nothing here */
export function inboxStop(inbox: SessionInbox | null | undefined): InboxStop | null {
  if (inbox?.stream === 'stopped_other_receiver') return 'other_receiver';
  if (inbox?.stream === 'stopped_taken_over') return 'taken_over';
  return null;
}
