'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { AttentionQueueItem } from '@/components/attention-queue/derive-attention-queue';

interface ExceptionStreamProps {
  /**
   * 손이 필요한 것(결재 대기·다른 일에 막힘·머지 가능) = 실 gate-pending/blocked/merge_ready
   * 신호만. project-scope gate fetch는 디디 병렬 BE(작음) — 미가용/BE 前엔 빈 배열로 정직
   * 빈상태 렌더.
   *
   * ⛔story #2365(2026-07-31) — 빈상태 문구가 「손 필요한 것 없음」(주어 없음)이었는데, 이
   * 서랍이 세는 표(WorkflowLineStepApproval, 승인 흐름/단계 결재)가 next-maker-header.tsx의
   * 「게이트 승인 대기」 카드와 «같은 화면에서» 만난다 — 30과 0이 나란히 서면 주어 없인
   * 자기모순으로 읽힌다. 「승인 흐름(단계 결재)에서 멈춘 것이 없습니다」로 주어를 박았다.
   *
   * ⛔story #2365 후속(유나 지적) — 빈상태만 고치고 «항목이 있을 때»의 개별 kindLabel
   * (`exceptionKindGatePending`="승인 대기")은 안 고쳐서, 서랍에 항목이 하나라도 생기면
   * 헤딩 카드의 「게이트 승인 대기」와 다시 주어 없이 만났다("지금 통과처럼 보이는 이유가
   * 서랍이 비어서" — 양성대조가 «실패할 수 없는» 표본이었다). kindLabel 셋을 한 번에
   * 갈랐다 — 「결재 대기」(게이트와 축자 불일치)·「다른 일에 막힘」(#2352가 금지한 「막힘」
   * 단독형을 안 씀)·「머지 가능」(그대로, 충돌 없음).
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
            // story #2923 AQ1 — AttentionQueueItem.href가 이제 string|null(inbox 병합 항목의
            // run/initiative 미가용 라우트 정직 처리)이라 타입이 넓어졌다. 이 스트림은
            // toExceptionQueueItems만 소비하는데 그쪽 hrefFor는 항상 non-null 문자열을 낸다
            // (gate_pending/blocked/merge_ready 3종 전부 안전 폴백 포함) — 이 null 분기는
            // 현재 아키텍처상 도달 불가지만, 타입을 거짓으로 좁히지 않고 hrefFor 자신의 기존
            // 관례(story_id 없으면 /board)와 동형으로 방어 폴백만 둔다.
            href={it.href ?? '/board'}
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
