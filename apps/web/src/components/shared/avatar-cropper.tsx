'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

const VIEWPORT = 220;
const OUTPUT = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

interface Transform {
  /** cover-fit(zoom=1) 기준 스케일. 실 렌더 스케일 = baseScale * zoom. */
  baseScale: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

function clampOffset(t: Transform, natW: number, natH: number): Transform {
  const scale = t.baseScale * t.zoom;
  const dispW = natW * scale;
  const dispH = natH * scale;
  const minX = Math.min(0, VIEWPORT - dispW);
  const minY = Math.min(0, VIEWPORT - dispH);
  return {
    ...t,
    offsetX: Math.min(0, Math.max(minX, t.offsetX)),
    offsetY: Math.min(0, Math.max(minY, t.offsetY)),
  };
}

/**
 * story #2887(S2g) — 업로드 후 정사각 크롭(원형 미리보기·확대 슬라이더). 목업
 * `s2g-avatar-mockup`의 crop UI를 실 동작으로: pointer 드래그 팬 + range 슬라이더 줌,
 * cover-fit 기본값 + 팬 클램프(빈 여백 노출 금지). 적용 시 OUTPUT×OUTPUT PNG Blob 콜백.
 */
export function AvatarCropper({
  imageUrl, onCancel, onApply,
}: {
  imageUrl: string;
  onCancel: () => void;
  onApply: (blob: Blob) => void;
}) {
  const t = useTranslations('settings');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natSize, setNatSize] = useState<{ w: number; h: number } | null>(null);
  const [transform, setTransform] = useState<Transform | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const natW = img.naturalWidth;
      const natH = img.naturalHeight;
      const baseScale = VIEWPORT / Math.min(natW, natH);
      setNatSize({ w: natW, h: natH });
      setTransform(clampOffset({
        baseScale, zoom: 1,
        offsetX: (VIEWPORT - natW * baseScale) / 2,
        offsetY: (VIEWPORT - natH * baseScale) / 2,
      }, natW, natH));
    };
    img.src = imageUrl;
    imgRef.current = img;
  }, [imageUrl]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!transform) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffsetX: transform.offsetX, startOffsetY: transform.offsetY };
  }, [transform]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !transform || !natSize) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setTransform(clampOffset({
      ...transform,
      offsetX: dragRef.current.startOffsetX + dx,
      offsetY: dragRef.current.startOffsetY + dy,
    }, natSize.w, natSize.h));
  }, [transform, natSize]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const onZoomChange = useCallback((zoom: number) => {
    if (!transform || !natSize) return;
    // 뷰포트 중심이 가리키는 이미지 지점을 유지한 채 스케일만 바꾼다(줌이 갑자기 튀지 않게).
    const oldScale = transform.baseScale * transform.zoom;
    const newScale = transform.baseScale * zoom;
    const cx = VIEWPORT / 2;
    const cy = VIEWPORT / 2;
    const imgX = (cx - transform.offsetX) / oldScale;
    const imgY = (cy - transform.offsetY) / oldScale;
    setTransform(clampOffset({
      ...transform, zoom,
      offsetX: cx - imgX * newScale,
      offsetY: cy - imgY * newScale,
    }, natSize.w, natSize.h));
  }, [transform, natSize]);

  const handleApply = useCallback(() => {
    if (!transform || !natSize || !imgRef.current) return;
    const scale = transform.baseScale * transform.zoom;
    const sx = -transform.offsetX / scale;
    const sy = -transform.offsetY / scale;
    const sSize = VIEWPORT / scale;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(imgRef.current, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob((blob) => { if (blob) onApply(blob); }, 'image/png');
  }, [transform, natSize, onApply]);

  if (!transform) {
    return <div className="text-sm text-muted-foreground">{t('avatarCropLoading')}</div>;
  }

  const scale = transform.baseScale * transform.zoom;

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative shrink-0 touch-none select-none overflow-hidden rounded-lg bg-muted"
        style={{ width: VIEWPORT, height: VIEWPORT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* imageUrl은 로컬 File을 URL.createObjectURL()로 감싼 blob: URI(next/image가 요구하는
            정적 크기/원격 도메인 전제와 안 맞음) + 캔버스 좌표계산이 실 픽셀 치수를 그대로
            참조해야 해 next/image의 자체 리사이즈 개입을 피한다. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={t('avatarCropPreviewAlt')}
          draggable={false}
          className="pointer-events-none absolute left-0 top-0 max-w-none"
          style={{
            width: natSize ? natSize.w * scale : undefined,
            height: natSize ? natSize.h * scale : undefined,
            transform: `translate(${transform.offsetX}px, ${transform.offsetY}px)`,
          }}
        />
        {/* 원형 크롭 가이드 오버레이 — 뷰포트 밖(사각 여백)만 어둡게, 실제 크롭 영역은 뷰포트 전체(정사각)와 동일하므로 원은 시각 가이드일 뿐. */}
        <div
          className="pointer-events-none absolute inset-[10px] rounded-full border-2 border-white/90"
          style={{ boxShadow: '0 0 0 999px rgba(0,0,0,0.35)' }}
        />
      </div>
      <div className="flex-1 space-y-3">
        <div className="text-sm font-semibold text-foreground">{t('avatarCropTitle')}</div>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={transform.zoom}
          onChange={(e) => onZoomChange(Number(e.target.value))}
          className="w-full accent-info"
          aria-label={t('avatarCropZoomLabel')}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={handleApply}>{t('avatarCropApply')}</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>{t('avatarCropCancel')}</Button>
        </div>
      </div>
    </div>
  );
}
