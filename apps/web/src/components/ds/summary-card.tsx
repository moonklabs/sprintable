import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type SummaryItem = {
  id: string | number;
  /** 항목 이름(예: «직무»). */
  label: ReactNode;
  /** 값. `null` · 빈 글이면 «—»로 그려진다(`emptyLabel`이 보이지 않는 이유 글). */
  value: ReactNode;
};

export type SummaryCardProps = Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> & {
  /** 카드 제목(예: «지금까지 고른 것»). 좁은 화면에서는 눈에는 안 보이고(스크린리더만 읽음) 항목만 칩 줄로 보인다. */
  title: ReactNode;
  items: readonly SummaryItem[];
  /** 항목이 하나도 없을 때 보이는 글. */
  emptyText?: ReactNode;
  /** 값이 비어 «—»로 그려질 때 스크린리더가 읽는 글(예: «아직 안 골랐어요»). 필수 — 보이는 «—»는 장식이라 이 글이 없으면 빈 값이 읽히지 않는다. */
  emptyLabel: string;
};

function isEmptyValue(v: ReactNode): boolean {
  return v === null || v === undefined || v === false || v === '';
}

/**
 * UI-3(a9d56577) SummaryCard — 요약 옆 칸: 제목 + «이름 / 값» 항목 목록(`dl`). `lg` 이상은 카드(면 `surface` · 헤어라인 · 모서리 4), 그 아래는 카드 껍데기 없이 항목이 칩 줄로 접힌다
 * (칩마다 «이름 값»이 글로 함께 읽힌다 — 색에 뜻을 싣지 않는다). 보이기만 하는 부품이라 눌림 · 초점이 없다.
 */
export function SummaryCard({ title, items, emptyText, emptyLabel, className, ...props }: SummaryCardProps) {
  const titleId = useId();
  return (
    <section {...props} data-slot="ds-summary-card" aria-labelledby={titleId} className={cn('lg:rounded-ds-control lg:border lg:border-ds-line lg:bg-ds-surface lg:p-3', className)}>
      <h2 id={titleId} className="m-0 text-ds-card-title font-semibold text-ds-ink max-lg:sr-only">{title}</h2>
      {items.length === 0 ? (
        emptyText ? <p className="m-0 mt-2 text-ds-small text-ds-ink-3 max-lg:mt-0">{emptyText}</p> : null
      ) : (
        <dl className="m-0 mt-2 flex flex-col gap-2 max-lg:mt-0 max-lg:flex-row max-lg:flex-wrap max-lg:gap-1.5">
          {items.map((item) => {
            const empty = isEmptyValue(item.value);
            return (
              <div
                key={item.id}
                data-slot="ds-summary-item"
                className="min-w-0 max-lg:inline-flex max-lg:items-baseline max-lg:gap-1 max-lg:rounded-ds-pill max-lg:border max-lg:border-ds-line max-lg:bg-ds-surface-sunk max-lg:px-2 max-lg:py-0.5"
              >
                <dt className="text-ds-small text-ds-ink-3">{item.label}</dt>
                <dd className="m-0 break-keep text-ds-body text-ds-ink [overflow-wrap:anywhere] lg:mt-0.5">
                  {empty ? (
                    <>
                      <span aria-hidden="true" className="text-ds-ink-3">—</span>
                      <span className="sr-only">{emptyLabel}</span>
                    </>
                  ) : (
                    item.value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
