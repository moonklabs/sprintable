'use client';

import { useTranslations } from 'next-intl';
import { Chip } from '@/components/ds/chip';
import { docStatusLabelKey, toDocStatusFilter, type DocStatusFilter } from './lib/doc-status-tone';

// story 4892 (UI-9 문서 화면) — 문서 상태 글 칩 하나(읽기 머리 · 첫 화면 · 결재 머리가 같은 것을 쓴다). ds Chip(점 + 글): 색만으로 뜻을 싣지 않고 상태 이름이 늘 글로 붙는다.
// 상태 → 칩 톤: 승인됨 = done · 검토 중 = info · 반려됨 = failed · 초안 = neutral. (트리 줄 점은 옛 DOC_STATUS_TONE 그대로 — 이 칩은 «글이 붙는 자리»용.)
const TONE: Record<DocStatusFilter, 'done' | 'info' | 'failed' | 'neutral'> = { confirmed: 'done', pending: 'info', denied: 'failed', draft: 'neutral' };

export function DocStatusChip({ status, className, ...rest }: { status: string | undefined; className?: string } & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const t = useTranslations('docs');
  const s = toDocStatusFilter(status);
  return (
    <Chip tone={TONE[s]} dot className={className} data-doc-status={s} {...rest}>
      {t(docStatusLabelKey(s))}
    </Chip>
  );
}
