'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type ExportFormat = 'png' | 'html';
export type ExportViewport = 'desktop' | 'mobile';
export type ExportTheme = 'light' | 'dark';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** mock — 실 GCS export 파이프(C1-S5) 미착지라 로컬 확認만. 실 연동 시 이 콜백이 실 업로드 호출로 교체. */
  onExport?: (format: ExportFormat, viewport: ExportViewport, theme: ExportTheme) => void;
}

/**
 * E-CANVAS C3 §5 — export 다이얼로그. PNG/HTML × viewport × theme 선택 → GCS 업로드(C1-S5,
 * 미착지)로 흐를 지점. 지금은 "내보냄 · URL 복사" 조용한 확認만(감점/강조 톤 아님, §5 원칙).
 */
export function ExportDialog({ open, onOpenChange, onExport }: ExportDialogProps) {
  const t = useTranslations('canvas');
  const [format, setFormat] = useState<ExportFormat>('png');
  const [viewport, setViewport] = useState<ExportViewport>('desktop');
  const [theme, setTheme] = useState<ExportTheme>('light');
  const [exported, setExported] = useState(false);

  const handleExport = () => {
    onExport?.(format, viewport, theme);
    setExported(true);
  };

  const handleClose = (o: boolean) => {
    if (!o) setExported(false);
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('exportDialogTitle')}</DialogTitle>
        </DialogHeader>

        {exported ? (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('exportedConfirmation')}</p>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('exportFormatLabel')}</p>
              <div className="flex gap-1.5">
                {(['png', 'html'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setFormat(f)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase ${format === f ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('exportViewportLabel')}</p>
              <div className="flex gap-1.5">
                {(['desktop', 'mobile'] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setViewport(v)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] ${viewport === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                    {v === 'desktop' ? t('viewportDesktop') : t('viewportMobile')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('exportThemeLabel')}</p>
              <div className="flex gap-1.5">
                {(['light', 'dark'] as const).map((th) => (
                  <button key={th} type="button" onClick={() => setTheme(th)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] ${theme === th ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                    {th === 'light' ? t('themeLight') : t('themeDark')}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {exported ? (
            <Button variant="outline" size="sm" onClick={() => handleClose(false)}>{t('closeAction')}</Button>
          ) : (
            <Button size="sm" onClick={handleExport}>{t('exportAction')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
