'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, XCircle } from 'lucide-react';
import type { SaveStatus } from '@/components/docs/use-doc-sync';

// story #3677(FE·대비·確定) — page.tsx(App Router page 파일)는 default export+정해진
// config export만 허용돼 named export가 있으면 Next build type check가 깨진다(카디르
// CI 실물). 테스트 격리를 위해 이 형제 모듈로 분리 — page.tsx는 import만.
export function InlineSaveIndicator({
  status,
  onAction,
  t,
}: {
  status: SaveStatus;
  onAction: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [show, setShow] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (status === 'idle') { setShow(false); setFading(false); return; }
    setShow(true);
    setFading(false);
    if (status !== 'saved') return;
    const t1 = setTimeout(() => setFading(true), 200);
    const t2 = setTimeout(() => setShow(false), 1600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [status]);

  if (!show) return null;

  if (status === 'saving') {
    return (
      <span aria-label={t('statusSaving')} title={t('statusSaving')} className="flex items-center">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span aria-label={t('statusSaved')} title={t('statusSaved')} className={`flex items-center transition-opacity duration-[1400ms] ${fading ? 'opacity-0' : 'opacity-100'}`}>
        <span className="size-2 rounded-full bg-success" />
      </span>
    );
  }
  if (status === 'unsaved') {
    return (
      <span aria-label={t('statusUnsaved')} title={t('statusUnsaved')} className="flex items-center">
        <span className="size-2 rounded-full bg-warning" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <button type="button" onClick={onAction}
        aria-label={`${t('statusError')} · ${t('retry')}`}
        title={`${t('statusError')} · ${t('retry')}`}
        // story #3677(FE·대비·確定) — hover:text-destructive/80은 resting state(text-
        // destructive, 알파 없음)보다 대비를 "낮추는" 방향이라 새 규칙 위반. 색은
        // 그대로 두고 underline으로 hover 피드백을 표현(대비 하락 0).
        className="flex max-w-[120px] items-center gap-1 truncate text-xs text-destructive hover:underline md:max-w-none"
      >
        <XCircle className="size-3.5 shrink-0" />
        <span className="truncate">{t('statusError')} · {t('retry')}</span>
      </button>
    );
  }
  // conflict / remote-changed are surfaced by DocSyncBanner (the off-ramp), not this
  // status chip — keeping a chip here too would double-surface and re-expose the
  // dead-end onAction. (fc4d4264 FIX-4)
  return null;
}
