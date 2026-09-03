'use client';

import { useTranslations } from 'next-intl';
import {
  contentPostStatusLabelKey,
  CONTENT_POST_STATUS_TONE,
  type ContentPostStatus,
} from '@/components/content/post-status';

/**
 * story #3368(Phase0·마케팅운영 S4) — 목록(page.tsx)·편집(content/[draftId]/page.tsx) 둘 다
 * 손으로 같은 마크업을 두 번 짓고 있던 것을 하나로 뽑는다(드리프트 원천 차단). data-status-
 * chip·data-chip-dot 두 속성은 유나 지시(doc phase0-post-manager-screen-design §8-3①)의
 * canvas 정규화 대비 측정 헬퍼(measureChip, e2e/content-post-manager-states.spec.ts)가
 * 쓰는 안정 셀렉터 — class 기반이 아니라 이 자리 하나만 보면 되게 한다.
 *
 * ⚠️opacity를 절대 쓰지 않는다(§8-3 "이 절이 고치는 내 앞선 말" — computed style은
 * opacity를 합성 못 해 측정이 조용히 새는 자리다).
 */
export function StatusChip({ status }: { status: ContentPostStatus }) {
  const t = useTranslations('content');
  const tone = CONTENT_POST_STATUS_TONE[status];
  return (
    <span
      data-status-chip={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
    >
      <span data-chip-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {t(contentPostStatusLabelKey(status))}
    </span>
  );
}
