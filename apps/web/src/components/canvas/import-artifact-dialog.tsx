'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArtifactStage } from './artifact-stage';
import { newNodeId, type ArtifactNode } from '@/services/canvas-nodes';
import { useJsonFieldDraft } from '@/hooks/use-json-field-draft';

type ImportTab = 'image' | 'html';

interface ImportArtifactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 실제 createArtifact(source='imported') 호출은 호출부가 소유(PinAuthoringPopover의
   * onSave와 동일 계약) — 이 다이얼로그는 업로드+미리보기+노드 구성까지만 책임진다. */
  onImport: (nodes: ArtifactNode[]) => Promise<boolean>;
  /** story #4370 — HTML 붙여넣기 초안 키(스토리 id). */
  targetId: string | null;
}

/**
 * story 64010b05(E-CANVAS C5 v1) — 임포트 다이얼로그. doc `e-canvas-c5-import-v1` §3 그대로:
 * 2입구(이미지 업로드·HTML 붙여넣기), Figma=export 이미지를 이미지 탭에 올리는 안내로 커버
 * (OAuth/API 0). 미리보기=기존 ArtifactStage 재사용(신규 뷰어 0). 실패=조용한 info 안내
 * (⛔낙인 0 — provenance 규율의 연장).
 */
interface ImportFormDraft { tab: ImportTab; imageUrl: string | null; html: string }
/** 빈 가져오기 폼(안정 참조 — 같으면 초안 없음). */
const EMPTY_IMPORT_FORM: ImportFormDraft = { tab: 'image', imageUrl: null, html: '' };

export function ImportArtifactDialog({ open, onOpenChange, onImport, targetId }: ImportArtifactDialogProps) {
  const t = useTranslations('canvas');
  const [uploading, setUploading] = useState(false);
  // story #4370(유나 판정 (가)) — 여러 줄 칸(HTML 붙여넣기)이 든 폼이라 **폼 전체**(탭 · 올린 이미지 · HTML)가 스토리별 초안 하나:
  // ✕ · 바깥 · Esc로 닫혀도 남고(다시 열면 쓰던 탭 그대로 — 숨은 초안 0) «취소» · 가져오기 성공에서만 지운다.
  // (예전엔 거꾸로 — Dialog 자체 닫힘에서만 비우고 «취소»는 남겼다.)
  const [form, setForm, clearFormDraft] = useJsonFieldDraft<ImportFormDraft>(
    { surface: 'artifact-import', targetId, field: 'form' }, EMPTY_IMPORT_FORM,
  );
  const { tab, imageUrl, html: htmlContent } = form;
  const setTab = (next: ImportTab) => setForm((prev) => ({ ...prev, tab: next }));
  const setImageUrl = (next: string | null) => setForm((prev) => ({ ...prev, imageUrl: next }));
  const setHtmlContent = (next: string) => setForm((prev) => ({ ...prev, html: next }));
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(false);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/visual-artifacts/import-image', { method: 'POST', body: formData });
      if (!res.ok) { setError(true); return; }
      const json = (await res.json()) as { data?: { url: string } };
      if (!json.data?.url) { setError(true); return; }
      setImageUrl(json.data.url);
    } catch {
      setError(true);
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm() {
    const nodes: ArtifactNode[] = tab === 'image'
      ? [{ id: newNodeId(), type: 'html_blob', props: { src: imageUrl }, parent_id: null, sort_order: 0 }]
      : [{ id: newNodeId(), type: 'html_blob', props: { html: htmlContent }, parent_id: null, sort_order: 0 }];
    setImporting(true);
    setError(false);
    const ok = await onImport(nodes);
    setImporting(false);
    if (!ok) { setError(true); return; }
    clearFormDraft();
    setError(false);
    onOpenChange(false);
  }

  const canConfirm = tab === 'image' ? (!!imageUrl && !uploading) : htmlContent.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setError(false); onOpenChange(next); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('importDialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-0.5 border-b border-border pb-2">
          {(['image', 'html'] as const).map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                tab === tabKey ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tabKey === 'image' ? t('importTabImage') : t('importTabHtml')}
            </button>
          ))}
        </div>

        {tab === 'image' ? (
          <div className="space-y-2">
            <input type="file" accept="image/*" onChange={(e) => void handleFileChange(e)} disabled={uploading} className="text-xs text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground">{t('importFigmaHint')}</p>
            {uploading ? <p className="text-[11px] text-muted-foreground">{t('importUploading')}</p> : null}
            {imageUrl ? (
              <div className="h-56 w-full overflow-hidden rounded-md border border-border">
                <ArtifactStage format="image" content={imageUrl} title={t('importPreviewTitle')} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={htmlContent}
              onChange={(e) => setHtmlContent(e.target.value)}
              placeholder={t('importHtmlPlaceholder')}
              rows={5}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {htmlContent.trim() ? (
              <div className="h-56 w-full overflow-hidden rounded-md border border-border">
                <ArtifactStage format="html" content={htmlContent} title={t('importPreviewTitle')} />
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="text-[11px] text-muted-foreground">{t('importFailedNote')}</p> : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => { clearFormDraft(); setError(false); onOpenChange(false); }} disabled={importing}>
            {t('specPinCancelAction')}
          </Button>
          <Button size="sm" onClick={() => void handleConfirm()} disabled={!canConfirm || importing}>
            {importing ? t('importingAction') : t('importConfirmAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
