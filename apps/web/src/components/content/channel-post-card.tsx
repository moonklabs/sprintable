import Link from 'next/link';
import { deriveChannelPostView, type ChannelPublicationStatus } from '@/components/content/channel-post-status';
import { StatusChip } from '@/components/content/status-chip';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { deriveFailureAction, type CommandStatus } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';
import { isSandboxChannelDraft, SandboxTestBadge } from '@/components/content/sandbox-test-badge';
import type { ChannelPostCalendarItem } from '@/components/content/use-channel-post-calendar-data';

// story #3422(doc §11 T8) — 캘린더 격자 셀과 「날짜 미정」 레인이 공유하는 유일한 렌더
// 단위(설계 코멘트 "ChannelPostCard가 유일한 렌더 단위" 그대로). deriveChannelPostView를
// 그대로 재사용해 칩을 만든다(§17-1 — 새 파생 금지). 실패/회수 오버레이(§17-2·§17-10)는
// B3(페드루 PO, 2026-09-04 13:14Z)에서 FailureActionBadge로 얹는다 — 칩 바로 아래.
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

  // B3(페드루 PO, 2026-09-04 13:14Z) — [draftId]/page.tsx와 동형 재사용(같은 함수·같은
  // 진리표, §17-2 "화면이 갈래를 다시 안 짠다").
  const failureAction = deriveFailureAction({
    commandStatus: item.command_status as CommandStatus | null | undefined,
    failureKind: item.failure_kind,
    nextRetryAt: item.next_retry_at,
    reasonCode: item.command_reason_code,
    processingKind: item.processing_kind,
  });

  return (
    <Link
      href={`/content/channel-posts/${item.draft_id}`}
      className="block space-y-1 rounded-md border border-border p-2 text-xs hover:bg-muted"
      data-testid="channel-post-calendar-card"
      data-status-chip={view.status ?? 'unknown'}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={view.status} />
          {/* story f30da19a AC5 — T8(캘린더 칸). */}
          {isSandboxChannelDraft(item.channel) ? <SandboxTestBadge /> : null}
        </div>
        {item.scheduled_at ? (
          <span className="text-muted-foreground" data-testid="channel-post-calendar-card-time">
            {formatScheduledAt(item.scheduled_at, displayTimezone).display}
          </span>
        ) : null}
      </div>
      {/* N3(페드루 PO, 2026-09-04 13:26Z) — 카드 전체가 <Link>라 그 안에 배지의
          <Button>을 그대로 두면 인터랙티브 요소가 중첩된다(a>button). compact로 라벨만
          받는다 — 재시도는 카드를 눌러 상세로 들어간 다음에 한다. */}
      {failureAction ? <FailureActionBadge action={failureAction} displayTimezone={displayTimezone} compact /> : null}
      {item.text_preview ? (
        <p className="truncate text-foreground" data-testid="channel-post-calendar-card-preview">{item.text_preview}</p>
      ) : null}
    </Link>
  );
}
