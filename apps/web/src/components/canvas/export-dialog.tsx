'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  applyCaptureConditions, canPngExport, createHtmlExport, exportPng,
  type ExportFormat, type BeArtifactExport,
} from '@/services/canvas-export';
import type { ArtifactFormat } from '@/services/canvas';

export type ExportViewport = 'desktop' | 'mobile';
export type ExportTheme = 'light' | 'dark';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactId: string;
  versionNumber: number;
  /** artifact가 실제 렌더된 DOM(ArtifactStage) — PNG 캡처 대상. */
  captureTargetRef: React.RefObject<HTMLElement | null>;
  /** html 포맷은 PNG 캡처 불가(샌드박스 iframe, canvas-export.ts 참고) — HTML export만 제공. */
  artifactFormat: ArtifactFormat;
}

/**
 * E-CANVAS C1-S5 — export 다이얼로그. 실 3-step(캡처→upload-url→PUT→complete, PNG) /
 * 단일 호출(HTML) 배선. "내보냄 · URL 복사" 조용한 확認만(감점/강조 톤 아님, §5 원칙).
 */
export function ExportDialog({ open, onOpenChange, artifactId, versionNumber, captureTargetRef, artifactFormat }: ExportDialogProps) {
  const t = useTranslations('canvas');
  const pngAllowed = canPngExport(artifactFormat);
  // 유나 §① "보이는 그대로"(WYSIWYG) — 테마 토글 초기값은 지금 보고 있는 테마여야 한다
  // (하드코딩 'light'는 위반). resolvedTheme이 'system'을 실제 적용 테마로 풀어준다.
  const { resolvedTheme } = useTheme();
  const [format, setFormat] = useState<ExportFormat>(pngAllowed ? 'png' : 'html');
  const [viewport, setViewport] = useState<ExportViewport>('desktop');
  const [theme, setTheme] = useState<ExportTheme>(resolvedTheme === 'dark' ? 'dark' : 'light');
  const [phase, setPhase] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<BeArtifactExport | null>(null);

  const handleExport = async () => {
    setPhase('exporting');
    try {
      if (format === 'html') {
        const r = await createHtmlExport(artifactId, versionNumber);
        setResult(r);
        setPhase(r ? 'done' : 'error');
        return;
      }
      const el = captureTargetRef.current;
      if (!el) { setPhase('error'); return; }
      const restore = applyCaptureConditions(el, viewport, theme);
      let r: BeArtifactExport | null;
      try {
        r = await exportPng(artifactId, versionNumber, el);
      } finally {
        restore();
      }
      setResult(r);
      setPhase(r ? 'done' : 'error');
    } catch {
      setPhase('error');
    }
  };

  const handleClose = (o: boolean) => {
    if (!o) { setPhase('idle'); setResult(null); }
    onOpenChange(o);
  };

  const handleCopyLink = () => {
    if (result?.download_url) void navigator.clipboard.writeText(result.download_url).catch(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('exportDialogTitle')}</DialogTitle>
        </DialogHeader>

        {phase === 'done' ? (
          <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p>{t('exportedConfirmation')}</p>
            {result?.download_url ? (
              <button type="button" onClick={handleCopyLink} className="font-semibold text-primary hover:underline">
                {t('exportCopyLinkAction')}
              </button>
            ) : null}
          </div>
        ) : phase === 'error' ? (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('exportFailedNote')}</p>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('exportFormatLabel')}</p>
              <div className="flex gap-1.5">
                {(['png', 'html'] as const).map((f) => (
                  <button
                    key={f} type="button" disabled={f === 'png' && !pngAllowed} onClick={() => setFormat(f)}
                    title={f === 'png' && !pngAllowed ? t('exportPngUnavailableForHtml') : undefined}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase disabled:cursor-not-allowed disabled:opacity-40 ${format === f ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              {!pngAllowed ? <p className="mt-1 text-[10px] text-muted-foreground/70">{t('exportPngUnavailableForHtml')}</p> : null}
            </div>
            {format === 'png' ? (
              <>
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
              </>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {phase === 'done' || phase === 'error' ? (
            <Button variant="outline" size="sm" onClick={() => handleClose(false)}>{t('closeAction')}</Button>
          ) : (
            <Button size="sm" onClick={() => void handleExport()} disabled={phase === 'exporting'}>
              {phase === 'exporting' ? t('exportingAction') : t('exportAction')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
