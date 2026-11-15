'use client';

import { useTranslations } from 'next-intl';
import type { DocHeading } from './doc-heading-utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';

// story #f546601e(v2 5호) — 긴 문서만 우측 미니 TOC를 자동 노출한다(유나 시안 확定,
// 실측 19헤딩 문서 기준). 기존 드롭다운 DocToc의 임계값(3, 클릭해야 보이는 팝오버라
// 얕은 문서에서도 빠른 점프에 유용)보다 높게 잡았다 — 이건 상시 공간을 차지하는
// 우측 레일이라, 짧은 문서까지 노출되면 오히려 소음(카드홍수류 회귀)이 된다. 6은
// "본문이 여러 뚜렷한 절로 나뉘어 있어야 스캔 가치가 생기는" 실용적 경계 — 3~5개는
// 목차 없이도 스크롤 한 번으로 전체 구조가 눈에 들어온다.
export const MINI_TOC_MIN_HEADINGS = 6;

interface DocMiniTocProps {
  headings: DocHeading[];
  activeId: string | null;
  onHeadingClick: (id: string) => void;
  className?: string;
}

export function DocMiniToc({ headings, activeId, onHeadingClick, className }: DocMiniTocProps) {
  const t = useTranslations('docs');

  if (headings.length < MINI_TOC_MIN_HEADINGS) return null;

  return (
    <nav
      aria-label={t('tocOnThisDoc')}
      className={cn('sticky top-6 max-h-[calc(100vh-8rem)] overflow-y-auto', className)}
    >
      <div className="mb-2 text-ds-small font-semibold text-ds-ink-3">
        {t('tocOnThisDoc')}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {headings.map((heading) => {
          const active = heading.id === activeId;
          return (
            <li key={heading.id}>
              <Button
                variant="quiet"
                onClick={() => onHeadingClick(heading.id)}
                aria-current={active ? 'location' : undefined}
                className={cn(
                  'h-auto min-h-7 w-full justify-start rounded-none border-0 border-l-2 px-0 py-0.5 text-left text-ds-small font-normal',
                  heading.level === 1 ? 'pl-2.5 font-medium' : heading.level === 2 ? 'pl-4' : 'pl-6',
                  active ? 'border-l-ds-action font-semibold text-ds-action-text' : 'border-l-transparent text-ds-ink-3',
                )}
              >
                <span className="min-w-0 truncate">{heading.text}</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
