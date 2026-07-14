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

export type ExportTheme = 'light' | 'dark';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactId: string;
  versionNumber: number;
  /** story d72db00a — ArtifactStage의 콘텐츠 레이어(`data-artifact-canvas-content`) 자체를
   * 직접 가리킨다(뷰어 크롬 제외, canvas_bounds 고정 프레임). PNG 캡처 대상. */
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
  const [theme, setTheme] = useState<ExportTheme>(resolvedTheme === 'dark' ? 'dark' : 'light');
  const [phase, setPhase] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<BeArtifactExport | null>(null);
  // export 실패 원인(캡처 throw 등)을 UI/로그에 노출 — 빈 catch가 삼켜 진단 불가였던 회귀 방지.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const handleExport = async () => {
    setPhase('exporting');
    setErrorDetail(null);
    try {
      if (format === 'html') {
        const r = await createHtmlExport(artifactId, versionNumber);
        setResult(r);
        setPhase(r ? 'done' : 'error');
        return;
      }
      const el = captureTargetRef.current;
      if (!el) { setPhase('error'); return; }
      const restore = applyCaptureConditions(el, theme);
      let r: BeArtifactExport | null;
      try {
        r = await exportPng(artifactId, versionNumber, el);
      } finally {
        restore();
      }
      setResult(r);
      setPhase(r ? 'done' : 'error');
    } catch (err) {
      // 빈 catch 금지(AC2) — 캡처/업로드 단계 throw의 원인을 로그+UI에 드러내 다음 진단 가능하게.
      console.error('[canvas-export] PNG export failed', err);
      setErrorDetail(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const handleClose = (o: boolean) => {
    if (!o) { setPhase('idle'); setResult(null); setErrorDetail(null); }
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
          <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <p>{t('exportFailedNote')}</p>
            {errorDetail ? (
              <p className="break-words font-mono text-[10px] text-muted-foreground/70">{errorDetail}</p>
            ) : null}
          </div>
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
