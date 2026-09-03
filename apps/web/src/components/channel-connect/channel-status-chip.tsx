'use client';

import { useTranslations } from 'next-intl';
import {
  channelConnectionStatusLabelKey,
  CHANNEL_CONNECTION_STATUS_TONE,
  type ChannelConnectionStatus,
} from '@/components/channel-connect/connection-status';

// story #3376 — Phase 0 content/status-chip.tsx와 동형(같은 규율: opacity 금지·
// data-status-chip 안정 셀렉터, doc §6-2-1 재사용).
export function ChannelStatusChip({ status }: { status: ChannelConnectionStatus }) {
  const t = useTranslations('channelConnect');
  const tone = CHANNEL_CONNECTION_STATUS_TONE[status];
  return (
    <span
      data-status-chip={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
    >
      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {t(channelConnectionStatusLabelKey(status))}
    </span>
  );
}
