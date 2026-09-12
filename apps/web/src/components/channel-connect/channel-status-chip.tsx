'use client';

import { useTranslations } from 'next-intl';
import {
  channelConnectionStatusLabelKey,
  CHANNEL_CONNECTION_STATUS_TONE,
  type ChannelConnectionStatus,
} from '@/components/channel-connect/connection-status';

// story #3376 — Phase 0 content/status-chip.tsx와 동형(같은 규율: opacity 금지·
// data-status-chip 안정 셀렉터, doc §6-2-1 재사용).
//
// story #3813 PR5-b CHANGES(유나 Design REQUESTED 2026-09-12) — `label`은
// provider_error 전용 오버라이드(예: 「요금제 제한」·「발신자 미인증」 — 코드별
// 구체 문구는 status 하나로 못 가른다, page.tsx가 last_error_code로 골라 넘긴다).
// 없으면 기존 status→labelKey 매핑 그대로(회귀 0).
export function ChannelStatusChip({ status, label }: { status: ChannelConnectionStatus; label?: string }) {
  const t = useTranslations('channelConnect');
  const tone = CHANNEL_CONNECTION_STATUS_TONE[status];
  return (
    <span
      data-status-chip={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
    >
      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {label ?? t(channelConnectionStatusLabelKey(status))}
    </span>
  );
}
