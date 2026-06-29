'use client';

import { createElement, useCallback, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { DownloadIcon, Loader2, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getFileIcon } from '@/lib/file-icon';
import { FILE_TINT_CLASS, fileExtLabel, fileTypeTint } from '@/lib/storage/format';
import { useToast } from '@/components/ui/toast';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader 오류'));
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.readAsDataURL(file);
  });
}

/** 파일 타입 글리프 — getFileIcon 결과를 createElement 로 직접 렌더(render 중 컴포넌트 생성 lint 회피). */
function fileGlyph(mimeType: string, className: string) {
  return createElement(getFileIcon(mimeType), { className });
}

// ─── File Attachment View ─────────────────────────────────────────────────────

function FileAttachmentView({ node }: ReactNodeViewProps) {
  const t = useTranslations('docs');
  const { addToast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const filename = (node.attrs['filename'] as string) ?? '';
  const size = (node.attrs['size'] as number) ?? 0;
  const mimeType = (node.attrs['mimeType'] as string) ?? '';
  const data = (node.attrs['data'] as string) ?? '';
  const assetId = node.attrs['assetId'] as string | null;
  const uploadId = node.attrs['uploadId'] as string | null;
  const uploading = node.attrs['uploading'] as boolean;
  const uploadError = node.attrs['uploadError'] as boolean;

  const isLegacy = typeof data === 'string' && data.startsWith('data:');

  const handleDownload = useCallback(async () => {
    // legacy(base64 data-url) — blob href 직접 다운로드(현 동작).
    if (isLegacy) {
      const a = document.createElement('a');
      a.href = data;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    // ref(assetId) — 서명 라우트 경유 새 탭(chat AttachmentFile 미러).
    if (!assetId || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/attachments/sign?asset_id=${encodeURIComponent(assetId)}&disposition=attachment`);
      if (res.status === 403) {
        addToast({ type: 'info', title: t('attachImagePrivate') });
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: { url?: string } } | null;
      const url = json?.data?.url;
      if (!res.ok || !url) {
        addToast({ type: 'error', title: t('attachFileUnavailable') });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      addToast({ type: 'error', title: t('attachFileUnavailable') });
    } finally {
      setDownloading(false);
    }
  }, [isLegacy, data, filename, assetId, downloading, addToast, t]);

  const retry = useCallback(() => {
    if (!uploadId) return;
    window.dispatchEvent(new CustomEvent('docs:attach-retry', { detail: { uploadId } }));
  }, [uploadId]);

  const cardBase = 'flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3';

  // ── 1. 업로딩 ──
  if (uploading) {
    return (
      <NodeViewWrapper as="div" className="my-3 not-prose">
        <div className={cardBase}>
          <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{filename}</p>
            <p className="text-xs text-muted-foreground">
              {t('attachUploading')}
              {size ? ` · ${formatFileSize(size)}` : ''}
            </p>
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  // ── 2. 에러 / unavailable ──
  if (uploadError) {
    return (
      <NodeViewWrapper as="div" className="my-3 not-prose">
        <div className={cardBase}>
          <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-destructive">{t('attachFileUnavailable')}</p>
            <p className="text-xs text-muted-foreground">{t('attachFileUnavailableHint')}</p>
          </div>
          {uploadId ? (
            <button
              type="button"
              contentEditable={false}
              onClick={retry}
              className="flex-shrink-0 text-xs font-semibold text-info hover:underline"
            >
              {t('attachRetry')}
            </button>
          ) : null}
        </div>
      </NodeViewWrapper>
    );
  }

  // ── 3. 로드 (legacy / ref 공통·타입 틴트 글리프) ──
  const tint = FILE_TINT_CLASS[fileTypeTint(mimeType)];
  const meta = `${fileExtLabel(mimeType, filename)} · ${formatFileSize(size)}`;
  return (
    <NodeViewWrapper as="div" className="my-3 not-prose">
      <div className={cardBase}>
        <span className={`flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-md ${tint}`}>
          {fileGlyph(mimeType, 'size-[18px]')}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{filename}</p>
          <p className="text-xs text-muted-foreground">{meta}</p>
        </div>
        <button
          type="button"
          contentEditable={false}
          onClick={() => void handleDownload()}
          disabled={downloading}
          className="flex-shrink-0 rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-info/40 hover:text-info disabled:opacity-60"
          aria-label={t('attachDownload')}
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <DownloadIcon className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </NodeViewWrapper>
  );
}

// ─── Node Definition ──────────────────────────────────────────────────────────

export const FileAttachmentNode = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      // 직접 HTML 파싱(save→load 라운드트립) 대칭 — parseHTML 부재 시 renderHTML 의
      // data-* 가 기본값으로 리셋되어 메타/legacy base64 가 유실된다.
      filename: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-filename') ?? '',
      },
      size: {
        default: 0,
        parseHTML: (el) => Number((el as HTMLElement).getAttribute('data-size') ?? 0) || 0,
      },
      mimeType: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mime-type') ?? '',
      },
      // legacy: base64 data-url 보관 / ref: 빈 문자열.
      data: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-file-data') ?? '',
      },
      // ref(assetId) — data-asset-id 라운드트립.
      // ⚠️ attr-level renderHTML 두지 않는다: 노드 renderHTML 이 HTMLAttributes.assetId 를 읽어
      // data-asset-id ↔ data-file-data 상호배타로 직렬화하기 때문. attr renderHTML 을 두면 assetId 가
      // HTMLAttributes 에서 data-asset-id 로 미리 매핑돼 노드 renderHTML 의 assetId 가 undefined →
      // 항상 data-file-data 로 직렬화되는 버그(파일 asset-ref 유실·dev 끝단 적출).
      assetId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-asset-id'),
      },
      // transient(직렬화 X).
      uploadId: { default: null, rendered: false },
      uploading: { default: false, rendered: false },
      uploadError: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="fileAttachment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { filename, size, mimeType, data, assetId } = HTMLAttributes as Record<string, unknown>;
    return [
      'div',
      mergeAttributes({
        'data-type': 'fileAttachment',
        'data-filename': filename,
        'data-size': String(size ?? 0),
        'data-mime-type': mimeType,
        // ref → data-asset-id(data-file-data 부재) · legacy → data-file-data(data-asset-id 부재). 상호배타.
        ...(assetId
          ? { 'data-asset-id': String(assetId) }
          : { 'data-file-data': data ?? '' }),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },
});
