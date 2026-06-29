'use client';

import { createElement, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { FILE_TINT_CLASS, fileExtLabel, fileTypeTint } from '@/lib/storage/format';
import type { Asset } from '@/lib/storage/types';
import { Skeleton } from '@/components/ui/skeleton';

/** 파일 타입 글리프 — getFileIcon 결과를 createElement 로 직접 렌더(render 중 컴포넌트 생성 lint 회피). */
function fileGlyph(contentType: string | null, className: string) {
  return createElement(getFileIcon(contentType), { className });
}

interface AssetEmbedCardProps {
  entityId: string;
  /** 토큰 라벨(`[name](entity:asset:id)`의 name) — fetch 전/실패 시 폴백 표시명. */
  label: string;
  /** 내 메시지(brand 버블) 위면 카드 배경을 반투명 화이트로(목업 ②). */
  ownMessage: boolean;
}

/**
 * S6 — 채팅 메시지 내 스토리지 자산 임베드 카드(목업 ② 1:1).
 * `/api/assets/{id}`로 단건 메타(name·content_type·size_bytes) 조회 →
 * 썸네일(타입 틴트 글리프) + 이름 + 메타 + 외부링크 화살표. 링크 `/storage?asset={id}`.
 * 로딩=스켈레톤·미존재(fetch 실패/404)=graceful(평문 라벨, 링크/화살표 제거).
 */
export function AssetEmbedCard({ entityId, label, ownMessage }: AssetEmbedCardProps) {
  const t = useTranslations('chats');
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setMissing(false);
      try {
        const r = await fetch(`/api/assets/${entityId}`);
        if (!r.ok) throw new Error('not-found');
        const json: { data?: Asset } | Asset = await r.json();
        if (cancelled) return;
        const data = (json as { data?: Asset }).data ?? (json as Asset);
        if (data && typeof data.id === 'string') setAsset(data);
        else setMissing(true);
      } catch {
        if (!cancelled) setMissing(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  // 내 메시지(brand 버블) 위: 반투명 화이트 카드(목업 .me .embed). 그 외: card 표면.
  const cardSurface = ownMessage ? 'border-white/20 bg-white/12 hover:bg-white/20' : 'border-border bg-card hover:bg-muted';
  const nameTone = ownMessage ? 'text-white' : 'text-foreground';
  const metaTone = ownMessage ? 'text-white/70' : 'text-muted-foreground';
  const arrowTone = ownMessage ? 'text-white/80' : 'text-muted-foreground/50';

  // ── 로딩: 스켈레톤 카드 ──
  if (loading) {
    return (
      <div className={`mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border px-2.5 py-2 ${cardSurface}`}>
        <Skeleton variant="rect" className="size-[38px] shrink-0 rounded-sm" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton variant="text" className="h-3 w-3/4" />
          <Skeleton variant="text" className="h-2.5 w-1/3" />
        </div>
      </div>
    );
  }

  // ── 미존재(graceful): 평문 라벨 + 파일 글리프, 링크/화살표 없음 ──
  if (missing || !asset) {
    return (
      <div className={`mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border px-2.5 py-2 ${ownMessage ? 'border-white/20 bg-white/12' : 'border-border bg-muted/40'}`}>
        <span className={`grid size-[38px] shrink-0 place-items-center rounded-sm ${ownMessage ? 'bg-white/15 text-white' : 'bg-muted text-muted-foreground'}`}>
          {fileGlyph(null, 'size-[17px]')}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[12.5px] font-semibold ${nameTone}`}>{label}</p>
          <p className={`mt-px text-[11px] ${metaTone}`}>{t('assetEmbedMissing')}</p>
        </div>
      </div>
    );
  }

  // ── 로드 완료: 썸네일 글리프 + 이름 + 메타 + 화살표 ──
  const tint = FILE_TINT_CLASS[fileTypeTint(asset.content_type)];
  const ext = fileExtLabel(asset.content_type, asset.name);
  const meta = `${ext} · ${formatFileSize(asset.size_bytes)}`;

  return (
    <Link
      href={`/storage?asset=${asset.id}`}
      className={`mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border px-2.5 py-2 no-underline transition-colors ${cardSurface}`}
    >
      {/* 썸네일 38×38 — 타입 틴트 글리프(서명 썸네일 필드 부재 → 글리프, 추후 affordance). */}
      <span className={`grid size-[38px] shrink-0 place-items-center overflow-hidden rounded-sm ${ownMessage ? 'bg-white/15 text-white' : tint}`}>
        {fileGlyph(asset.content_type, 'size-[17px]')}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[12.5px] font-semibold ${nameTone}`}>{asset.name}</p>
        <p className={`mt-px text-[11px] ${metaTone}`}>{meta}</p>
      </div>
      <ExternalLink className={`size-[15px] shrink-0 ${arrowTone}`} aria-hidden />
    </Link>
  );
}
