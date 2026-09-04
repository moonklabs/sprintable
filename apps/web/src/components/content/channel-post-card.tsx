import Link from 'next/link';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { StatusChip } from '@/components/content/status-chip';
import { formatScheduledAt } from '@/components/content/schedule-format';
import type { ChannelPostCalendarItem } from '@/components/content/use-channel-post-calendar-data';

// story #3422(doc §11 T8) — 캘린더 격자 셀과 「날짜 미정」 레인이 공유하는 유일한 렌더
// 단위(설계 코멘트 "ChannelPostCard가 유일한 렌더 단위" 그대로). deriveChannelPostView를
// 그대로 재사용해 칩을 만든다(§17-1 — 새 파생 금지). 실패/회수 오버레이(§17-2·§17-10)는
// ②-c가 FailureActionBadge로 얹는다 — 이 조각은 칩+시각까지만.
export interface ChannelPostCardProps {
  item: ChannelPostCalendarItem;
  /** 그리드/레인이 공유하는 단일 tz 출처(schedule-format.ts::resolveDisplayTimezone) —
   * 셀마다 다시 계산하지 않는다(그룹핑·표기가 어긋나지 않게, story #3422 설계). */
  displayTimezone: string;
}

export function ChannelPostCard({ item, displayTimezone }: ChannelPostCardProps) {
  const hasGateContract = 'gate_status' in item;
  const view = hasGateContract
    ? deriveChannelPostView({
        gateStatus: item.gate_status === 'pending' || item.gate_status === 'approved' || item.gate_status === 'rejected'
          ? item.gate_status : undefined,
        reapprovalRequired: item.reapproval_required ?? undefined,
        sealedBodySha256: item.sealed_content_sha256 ?? undefined,
        currentBodySha256: item.body_sha256,
        publishedBodySha256: item.published_body_sha256 ?? undefined,
        publicationStatus: item.publication_status as ChannelPublicationStatus | null | undefined,
        errorCode: item.error_code,
        publishedAt: 'published_at' in item ? item.published_at : undefined,
      })
    : { status: undefined, publishable: false, partialSuccess: false, publicationFailed: false, errorCode: undefined, unpublished: false, isRepublish: undefined, blockedReason: undefined };

  return (
    <Link
      href={`/content/channel-posts/${item.draft_id}`}
      className="block space-y-1 rounded-md border border-border p-2 text-xs hover:bg-muted"
      data-testid="channel-post-calendar-card"
      data-status-chip={view.status ?? 'unknown'}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusChip status={view.status} />
        {item.scheduled_at ? (
          <span className="text-muted-foreground" data-testid="channel-post-calendar-card-time">
            {formatScheduledAt(item.scheduled_at, displayTimezone).display}
          </span>
        ) : null}
      </div>
      {item.text_preview ? (
        <p className="truncate text-foreground" data-testid="channel-post-calendar-card-preview">{item.text_preview}</p>
      ) : null}
    </Link>
  );
}
