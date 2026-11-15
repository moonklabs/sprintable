'use client';

// story 4906 (lap 3 · PO 11-14) — the line above a room's composer when the home's instruction was MOVED here instead of sent (the person has no single agent DM, 3831 «no receiver invented»).
// It names the room and says why nothing was sent; ChatView draws it only while the moved text is still in the box. A status (read politely) — nothing failed.
import { Banner } from '@/components/ds/banner';

export function ComposeMovedNotice({ text }: { text: string }) {
  return (
    <div className="px-3 pt-2" data-testid="compose-moved-notice">
      <Banner tone="info">{text}</Banner>
    </div>
  );
}
