'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { AttentionQueueItem } from '@/components/attention-queue/derive-attention-queue';

interface ExceptionStreamProps {
  /**
   * 손이 필요한 것(승인 대기·막힘·병합 대기) = 실 gate-pending/blocked 신호만. project-scope gate
   * fetch는 디디 병렬 BE(작음) — 미가용/BE 前엔 빈 배열로 정직 빈상태 렌더.
   *
   * ⛔story #2365(2026-07-31) — 빈상태 문구가 「손 필요한 것 없음」(주어 없음)이었는데, 이
   * 서랍이 세는 표(WorkflowLineStepApproval, 승인 흐름/단계 결재)가 next-maker-header.tsx의
   * 「게이트 승인 대기」 카드와 «같은 화면에서» 만난다 — 30과 0이 나란히 서면 주어 없인
   * 자기모순으로 읽힌다. 「승인 흐름(단계 결재)에서 멈춘 것이 없습니다」로 주어를 박았다.
   */
  items?: AttentionQueueItem[];
}

const DOT_BY_STATE: Record<string, string> = {
  amber: 'bg-proof-amber',
  green: 'bg-proof-green',
  blue: 'bg-proof-blue',
  red: 'bg-proof-red',
};

/**
 * E-GLANCE 2D 예외 스트림(story dee92c96) — "감시 아니라 신뢰": 개입이 필요한 예외만 올라온다
 * (활동량/타임스탬프/순위 0). AttentionQueue 파생 재사용. no-fiction: 실 신호 없으면 억지 렌더 X →
 * 정직 빈상태. 디디 gate-fetch BE가 오면 상위(glance-board)가 파생 items를 내려준다.
 */
export function ExceptionStream({ items = [] }: ExceptionStreamProps) {
  const t = useTranslations('glance');

  if (items.length === 0) {
    return <p className="px-1 py-3 text-[11.5px] text-muted-foreground">{t('exceptionsEmpty')}</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.id}>
          <Link
            href={it.href}
            className="flex items-start gap-2.5 rounded-lg border border-proof-line-soft bg-proof-panel px-3 py-2 transition-colors hover:border-proof-line"
          >
            <span className={`mt-1 size-1.5 shrink-0 rounded-full ${DOT_BY_STATE[it.proofState] ?? 'bg-proof-ink-3'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-proof-ink-3">{it.kindLabel}</span>
                {it.actor ? <span className="truncate text-[10px] font-semibold text-proof-ink-3">· {it.actor.name}</span> : null}
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] font-medium text-proof-ink">{it.claim}</span>
            </span>
            <span className="shrink-0 self-center text-[11px] font-bold text-proof-blue">{it.actionLabel}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
