'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface ChatProofMessage {
  id: string;
  senderName: string;
  content: string;
}

export interface ChatProofEmbedProps {
  /** 출처줄: "채팅 · 7/26 · 오르테가군 외 2명" 같은 완성 문구(호출부가 조립 — 이 컴포넌트는
   * 문구를 지어내지 않는다). */
  sourceLabel: string;
  /** "대화에서 열기"의 목적지. null이면 그 링크 자체를 안 그린다(권한 없음 케이스와 동형이지만
   * 별개 축 — 아래 status와 독립). */
  conversationHref: string | null;
  messages: ChatProofMessage[];
  /** 인용 시점(항상 필요 — deleted 상태의 "인용 시점" 문구에 쓰인다). */
  quotedAt: string;
  status: 'normal' | 'edited' | 'deleted' | 'no_access';
  /** status="edited"일 때만 의미 있음. */
  editedAt?: string;
  truncatedBefore?: number;
  truncatedAfter?: number;
  className?: string;
}

/**
 * story #2265(C-7) PR1a — 대화 일부를 view-only로 박는 렌더. props로만 데이터를 받아
 * 실제 라우트(설계 진행 중, #2262 C-4와 자리 겹침 조율 中)와 분리해 먼저 세운다(PO 지시,
 * 2026-07-29 — "라우트가 뭐가 되든 안 흔들리는 자리"). PR1b가 실 데이터를 연결한다.
 *
 * 화면 규격(유나 확定 2026-07-28, PO 채택):
 * - 카드(테두리 상자) 금지 — 본문과 같은 배경 + 좌측 세로선(인용 관용구).
 * - 회색으로 죽이지 않는다 — 증거는 읽히라고 박은 것(본문과 같은 명도).
 * - 원본 변경은 "얹기"다 — 내용을 조용히 교체하지 않고 출처줄에 신호만 덧붙인다.
 * - 삭제 ≠ 권한 상실 — 서로 다른 문구·다른 렌더(no_access는 내용 자체를 안 보인다).
 */
export function ChatProofEmbed({
  sourceLabel, conversationHref, messages, quotedAt, status, editedAt,
  truncatedBefore, truncatedAfter, className,
}: ChatProofEmbedProps) {
  const t = useTranslations('verify');

  if (status === 'no_access') {
    return (
      <div className={cn('border-l-2 border-border py-1.5 pl-3', className)}>
        <p className="text-[11.5px] text-muted-foreground">{t('chatProofNoAccess')}</p>
      </div>
    );
  }

  return (
    <div className={cn('border-l-2 border-border py-1.5 pl-3', className)}>
      <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{sourceLabel}</span>
        {conversationHref ? (
          <Link href={conversationHref} className="text-primary hover:underline">
            {t('chatProofOpenSource')}
          </Link>
        ) : null}
        {status === 'edited' ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('chatProofEdited', { date: editedAt ?? '' })}</span>
            {conversationHref ? (
              <Link href={conversationHref} className="text-primary hover:underline">
                {t('chatProofOpenOriginal')}
              </Link>
            ) : null}
          </>
        ) : null}
        {status === 'deleted' ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('chatProofDeleted', { date: quotedAt })}</span>
          </>
        ) : null}
      </div>

      {status === 'deleted' ? (
        <p className="text-[11.5px] text-muted-foreground">
          <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px]">{t('chatProofDeletedTag')}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {truncatedBefore ? (
            <p className="text-[10.5px] text-muted-foreground">{t('chatProofTruncatedBefore', { count: truncatedBefore })}</p>
          ) : null}
          {messages.map((m) => (
            <p key={m.id} className="text-[13px] leading-snug text-foreground">
              <span className="font-medium">{m.senderName}</span>{' '}
              <span className="[overflow-wrap:anywhere]">{m.content}</span>
            </p>
          ))}
          {truncatedAfter ? (
            <p className="text-[10.5px] text-muted-foreground">{t('chatProofTruncatedAfter', { count: truncatedAfter })}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
