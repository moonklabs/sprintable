'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import { Icon } from '@/components/ds/icon';
import type { DocHeading } from './doc-heading-utils';
import { cn } from '@/lib/utils';
import { AnchoredPopover, isOutsidePress, usePortalMenuKeys } from '@/components/shared/anchored-popover';

interface DocTocProps {
  headings: DocHeading[];
  onHeadingClick: (id: string) => void;
  className?: string;
}

export function DocToc({ headings, onHeadingClick, className }: DocTocProps) {
  // story #3776(1층A) — "목차" 라벨, docs ns의 기존 tocSection 키 재사용.
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // story #4342 — 목록이 좁은 화면에서 뷰포트 밖으로 나가지 않게(열릴 때 재서 안으로 밀어 넣음 · 폭 상한).
  // story #4349(전수 11번) — 목차 패널은 문서 본문 · 에디터 카드(`overflow-hidden`) 안의 absolute였다 → body로 포털(AnchoredPopover ·
  // 아래 모자라면 위로 · 가로는 4342 클램프). 포털이라 DOM 순서상 버튼 뒤가 아니다 → 버튼에서 Tab이면 패널로 · 끝을 넘거나 Esc면 닫고 버튼으로.
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const keys = usePortalMenuKeys({ open, onClose: close, popoverRef: listRef, triggerRef: buttonRef, kind: 'panel' });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (isOutsidePress(panelRef.current, e.target)) setOpen(false); // 포털된 목록(listRef)은 공용 규칙이 «안»으로 셈
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleClick = useCallback((id: string) => {
    onHeadingClick(id);
    setOpen(false);
  }, [onHeadingClick]);

  // AC5: 3개 미만이면 숨김
  if (headings.length < 3) return null;

  return (
    <div ref={panelRef} className={cn('relative', className)}>
      {/* story 4892 (UI-9 문서 상세 열) — «목차» 단추 = ds Button(열려 있으면 보조 윤곽 · 닫히면 조용). 포털 · 키 길(usePortalMenuKeys)은 그대로. */}
      <Button
        ref={buttonRef}
        {...keys.triggerProps}
        variant={open ? 'secondary' : 'quiet'}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={keys.onTriggerKeyDown}
        title={t('tocSection')}
        iconStart={<Icon name="list" size={14} />}
      >
        {t('tocSection')}
      </Button>

      {open && (
        <AnchoredPopover anchorRef={panelRef} popoverRef={listRef} align="end" gap={6} onKeyDown={keys.onPopoverKeyDown} {...keys.popoverProps} data-dropdown-panel="doc-toc" className="z-50 w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-ds-panel border border-ds-line-control bg-ds-surface-raised">
          <div className="flex items-center justify-between border-b border-ds-line px-3 py-1">
            <span className="text-ds-small font-semibold text-ds-ink">{t('tocSection')}</span>
            {/* 유나 #4728 — 새 키보드 길(«목차» → Tab)의 첫 자리. 이름(common.close)을 달고, 닫을 땐 Esc와 같은 길(닫고 «목차»로 초점) — 예전엔 초점이 body로 떨어졌다. */}
            <IconButton icon="close" label={tc('close')} onClick={keys.closeToTrigger} />
          </div>
          <nav className="focus-inset max-h-72 overflow-y-auto py-1.5">
            {headings.map((heading) => (
              <Button
                key={heading.id}
                variant="quiet"
                onClick={() => handleClick(heading.id)}
                className={cn(
                  'h-auto min-h-8 w-full justify-start gap-1.5 whitespace-normal rounded-none px-3 py-1.5 text-left text-ds-small font-normal',
                  heading.level === 1 ? 'font-semibold text-ds-ink' : heading.level === 2 ? 'pl-5 text-ds-ink-2' : 'pl-7 text-ds-ink-3',
                )}
              >
                <span aria-hidden="true" className="mt-px shrink-0 text-ds-ink-3">
                  {heading.level === 1 ? '◆' : heading.level === 2 ? '◇' : '·'}
                </span>
                <span className="min-w-0 truncate">{heading.text}</span>
              </Button>
            ))}
          </nav>
        </AnchoredPopover>
      )}
    </div>
  );
}
