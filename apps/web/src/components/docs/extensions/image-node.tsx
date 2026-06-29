'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { Loader2, ImageOff, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatFileSize } from './file-node';

// 첨부 src 분류 — regression 0 의 핵심.
// legacy(data:/http(s)/blob) → 직접 렌더(현 비주얼) · ref(assetId attr) → signed fetch.
function isLegacySrc(src: unknown): src is string {
  return typeof src === 'string' && src.length > 0;
}

type SignState = 'fetching' | 'ok' | 'error' | 'public';

// ─── Resize handles (legacy·ref-loaded 공용·width PRESERVE) ─────────────────────
function useResize(updateAttributes: (a: Record<string, unknown>) => void) {
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, side: 'left' | 'right') => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = imgRef.current?.offsetWidth ?? 300;

      const onMouseMove = (me: MouseEvent) => {
        const delta = me.clientX - startXRef.current;
        const newWidth = Math.max(80, startWidthRef.current + (side === 'right' ? delta : -delta));
        updateAttributes({ width: Math.round(newWidth) });
      };
      const onMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [updateAttributes],
  );

  return { isResizing, imgRef, handleResizeStart };
}

function ResizeHandles({ onStart }: { onStart: (e: React.MouseEvent, side: 'left' | 'right') => void }) {
  return (
    <>
      <div
        role="separator"
        aria-label="왼쪽 리사이즈 핸들"
        onMouseDown={(e) => onStart(e, 'left')}
        className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-3 cursor-ew-resize rounded-sm border border-border bg-background shadow-md hover:bg-muted"
      />
      <div
        role="separator"
        aria-label="오른쪽 리사이즈 핸들"
        onMouseDown={(e) => onStart(e, 'right')}
        className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 h-8 w-3 cursor-ew-resize rounded-sm border border-border bg-background shadow-md hover:bg-muted"
      />
    </>
  );
}

// 상태 박스(uploading/error/public) — 목업 .imgbox aspect 4/3 + 토큰 매핑.
function StateBox({ tone, children }: { tone: 'muted' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={`relative grid aspect-[4/3] w-full max-w-sm place-items-center overflow-hidden rounded-xl border border-border ${
        tone === 'error' ? 'bg-destructive/10' : 'bg-muted'
      }`}
    >
      {children}
    </div>
  );
}

function ImageView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const t = useTranslations('docs');
  const { isResizing, imgRef, handleResizeStart } = useResize(updateAttributes);

  const src = node.attrs['src'] as string | null;
  const alt = (node.attrs['alt'] as string) ?? '';
  const width = node.attrs['width'] as number | null;
  const assetId = node.attrs['assetId'] as string | null;
  const filename = (node.attrs['filename'] as string) ?? '';
  const size = (node.attrs['size'] as number) ?? 0;
  const uploadId = node.attrs['uploadId'] as string | null;
  const uploading = node.attrs['uploading'] as boolean;
  const uploadError = node.attrs['uploadError'] as boolean;

  // data: URL 이면 legacy(직접) — assetId 가 있어도 src 가 data 면 legacy 우선(regression 0).
  const isLegacy = typeof src === 'string' && src.startsWith('data:');
  const isRef = !!assetId && !isLegacy;

  // ── signed URL fetch (ref 전용·chat AttachmentImage 미러) ──
  const [signState, setSignState] = useState<SignState>('fetching');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const retriedRef = useRef(false);

  const fetchSigned = useCallback(async () => {
    if (!assetId) return;
    try {
      const res = await fetch(`/api/attachments/sign?asset_id=${encodeURIComponent(assetId)}`);
      if (res.status === 403) {
        setSignState('public');
        return;
      }
      if (!res.ok) {
        setSignState('error');
        return;
      }
      const json = (await res.json()) as { data?: { url?: string } };
      const url = json.data?.url;
      if (!url) {
        setSignState('error');
        return;
      }
      setSignedUrl(url);
      setSignState('ok');
    } catch {
      setSignState('error');
    }
  }, [assetId]);

  useEffect(() => {
    if (!isRef) return;
    retriedRef.current = false;
    // 외부 시스템(서명 라우트) 비동기 fetch — setState 는 모두 await 이후라 동기 cascade 아님.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSigned();
  }, [isRef, fetchSigned]);

  const handleImgError = useCallback(() => {
    if (!retriedRef.current) {
      retriedRef.current = true;
      void fetchSigned();
    } else {
      setSignState('error');
    }
  }, [fetchSigned]);

  const reload = useCallback(() => {
    retriedRef.current = false;
    setSignState('fetching');
    void fetchSigned();
  }, [fetchSigned]);

  // error 카드 "다시 시도": 업로드 실패(uploadId 보유) → 재업로드 이벤트 / ref 서명 실패 → 재fetch.
  const handleErrorRetry = useCallback(() => {
    if (uploadError && uploadId) {
      window.dispatchEvent(new CustomEvent('docs:attach-retry', { detail: { uploadId } }));
    } else {
      reload();
    }
  }, [uploadError, uploadId, reload]);

  // ── 1. 업로딩 ──
  if (uploading) {
    return (
      <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full not-prose">
        <StateBox tone="muted">
          <div className="absolute inset-0 animate-pulse bg-muted" aria-hidden />
          <div className="relative z-[1] flex flex-col items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-[18px] animate-spin text-info" aria-hidden />
            <span>{t('attachUploading')}</span>
            <span className="text-[10px]">
              {filename}
              {size ? ` · ${formatFileSize(size)}` : ''}
            </span>
          </div>
        </StateBox>
      </NodeViewWrapper>
    );
  }

  // ── 2. 업로드 실패 / unavailable ──
  if (uploadError || (isRef && signState === 'error')) {
    return (
      <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full not-prose">
        <StateBox tone="error">
          <div className="flex flex-col items-center gap-2 text-xs text-destructive">
            <ImageOff className="size-[22px]" aria-hidden />
            <span>{t('attachImageUnavailable')}</span>
            {isRef || (uploadError && uploadId) ? (
              <button
                type="button"
                contentEditable={false}
                onClick={handleErrorRetry}
                className="mt-0.5 font-semibold text-info hover:underline"
              >
                {t('attachRetry')}
              </button>
            ) : null}
          </div>
        </StateBox>
      </NodeViewWrapper>
    );
  }

  // ── 3. ref: signed 렌더 ──
  if (isRef) {
    if (signState === 'public') {
      return (
        <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full not-prose">
          <StateBox tone="muted">
            <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
              <Lock className="size-[22px]" aria-hidden />
              <span>{t('attachImagePrivate')}</span>
            </div>
          </StateBox>
        </NodeViewWrapper>
      );
    }
    if (signState === 'fetching' || !signedUrl) {
      return (
        <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full not-prose">
          <StateBox tone="muted">
            <div className="absolute inset-0 animate-pulse bg-muted" aria-busy="true" aria-label={alt} />
          </StateBox>
        </NodeViewWrapper>
      );
    }
    // loaded(현 비주얼·resize/width PRESERVE)
    return (
      <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={signedUrl}
          alt={alt}
          draggable={false}
          onError={handleImgError}
          style={{ width: width ? `${width}px` : undefined, maxWidth: '100%', height: 'auto', display: 'block' }}
          className={`rounded-xl border border-border object-contain transition-shadow ${
            selected ? 'ring-2 ring-brand ring-offset-1' : ''
          } ${isResizing ? 'select-none' : ''}`}
        />
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-px text-[9px] font-medium text-white">
          {t('attachAssetTag')}
        </span>
        {selected ? <ResizeHandles onStart={handleResizeStart} /> : null}
      </NodeViewWrapper>
    );
  }

  // ── 4. legacy(data:/http/blob) 직접 렌더 — 현 비주얼·regression 0 ──
  return (
    <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={isLegacySrc(src) ? src : undefined}
        alt={alt}
        draggable={false}
        style={{ width: width ? `${width}px` : undefined, maxWidth: '100%', height: 'auto', display: 'block' }}
        className={`rounded-xl border border-border object-contain transition-shadow ${
          selected ? 'ring-2 ring-brand ring-offset-1' : ''
        } ${isResizing ? 'select-none' : ''}`}
      />
      {selected ? <ResizeHandles onStart={handleResizeStart} /> : null}
    </NodeViewWrapper>
  );
}

// ─── Node Definition ──────────────────────────────────────────────────────────
// 기존 Image 노드 확장 — width(현행) + asset-ref attrs(assetId/filename/size/mime) + transient(uploadId/uploading/uploadError).
export const CustomImageNode = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const style = (el as HTMLElement).style.width;
          if (style) return parseInt(style, 10) || null;
          return (el as HTMLElement).getAttribute('width') ? Number((el as HTMLElement).getAttribute('width')) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes['width']) return {};
          return { style: `width:${attributes['width']}px;max-width:100%;height:auto` };
        },
      },
      // asset-ref (LOCK: {assetId, filename, size, mime}) — data-* 라운드트립.
      assetId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-asset-id'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes['assetId'] ? { 'data-asset-id': String(attributes['assetId']) } : {},
      },
      filename: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-filename'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes['filename'] ? { 'data-filename': String(attributes['filename']) } : {},
      },
      size: {
        default: null,
        parseHTML: (el) => {
          const s = (el as HTMLElement).getAttribute('data-size');
          return s ? Number(s) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes['size'] ? { 'data-size': String(attributes['size']) } : {},
      },
      mime: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mime-type'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes['mime'] ? { 'data-mime-type': String(attributes['mime']) } : {},
      },
      // transient(직렬화 X) — 옵티미스틱 업로드 추적.
      uploadId: { default: null, rendered: false },
      uploading: { default: false, rendered: false },
      uploadError: { default: false, rendered: false },
    };
  },

  // ref 노드(src 없음)도 파싱되도록 data-asset-id 태그 추가.
  parseHTML() {
    return [{ tag: 'img[src]' }, { tag: 'img[data-asset-id]' }];
  },

  // ref 직렬화: src 미persist(서명 URL 은 렌더시에만 해석). legacy: src(data:) 그대로.
  renderHTML({ node, HTMLAttributes }) {
    const attrs: Record<string, unknown> = { ...HTMLAttributes };
    if (node.attrs['assetId']) delete attrs['src'];
    return ['img', mergeAttributes(attrs)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
