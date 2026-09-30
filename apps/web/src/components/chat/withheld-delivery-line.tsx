'use client';

import { Ban } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { DeliveryWithheld } from '@/hooks/use-chat-sse';

/**
 * story #4430 (design: artifact 12b94be8, Yuna) — under the sender's own bubble: the message was posted, but a block kept it
 * from some participants. Visible text (no tooltip), muted, no red and no button (there is nothing for the sender to do);
 * a 1:1 line or a count line for a group (never who). An unknown room kind takes the count line (true for any count).
 * Only for the sender's own messages — the server sends the field to the sender only, and callers pass `isMine` too.
 */
export function WithheldDeliveryLine({ withheld, isMine }: { withheld: DeliveryWithheld | undefined; isMine: boolean }) {
  const t = useTranslations('chats');
  if (!isMine || !withheld || withheld.withheld_count <= 0) return null;
  const text = withheld.conversation_type === 'dm'
    ? t('withheldDeliveryDm')
    : t('withheldDeliveryGroup', { n: withheld.withheld_count });
  return (
    <p
      data-testid="withheld-delivery-line"
      className="mt-1 flex items-start justify-end gap-1 text-right text-xs text-muted-foreground break-keep"
    >
      <Ban aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
