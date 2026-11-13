import { useTranslations } from 'next-intl';
import { Chip, type ChipProps } from '@/components/ds/chip';

export type LoopStatus =
  | 'draft'
  | 'briefing'
  | 'generating'
  | 'deciding'
  | 'executing'
  | 'measuring'
  | 'closed'
  | 'abandoned';

/**
 * 8-state loop status chip (E-LOOP-LEDGER S6 — handoff §3 · 4911에서 ds Chip으로).
 * 뜻 색은 «뜻»일 때만: deciding = needs-hand(사람이 결정할 차례) · closed = done · 준비/진행(briefing · generating · executing · measuring) = info ·
 * draft(아직 시작 전)와 abandoned(접음)은 중립 — 점 없는 중립 칩이 «시작 전», 점 있는 중립 칩이 «접음».
 * 공용 status-badge.tsx와 섞지 않는다(8상태가 각기 다른 위계라 도메인 전용으로 둔다).
 */
const TONE: Record<LoopStatus, Pick<ChipProps, 'tone'> & { dot: boolean }> = {
  draft: { tone: 'neutral', dot: false },
  briefing: { tone: 'info', dot: true },
  generating: { tone: 'info', dot: true },
  deciding: { tone: 'needs-hand', dot: true },
  executing: { tone: 'info', dot: true },
  measuring: { tone: 'info', dot: true },
  closed: { tone: 'done', dot: true },
  abandoned: { tone: 'neutral', dot: true },
};

export function LoopStatusBadge({ status, className }: { status: LoopStatus; className?: string }) {
  const t = useTranslations('loops');
  const labelKey = `status${status.charAt(0).toUpperCase()}${status.slice(1)}` as 'statusDraft';
  // 이 화면이 아직 모르는 상태(새 BE 상태 · 시험 픽스처)로 화면이 죽지 않게 «접음» 모양으로 낮춘다(옛 배지도 기본 갈래가 그랬다).
  const known = status in TONE;
  const { tone, dot } = TONE[status] ?? TONE.abandoned;
  return (
    <Chip tone={tone} dot={dot} data-loop-status={status} className={className}>
      {known ? t(labelKey) : status}
    </Chip>
  );
}
