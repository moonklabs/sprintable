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
import { fetchWithAuth } from '@/lib/db/client';
import type { ReadingPanelTarget } from '@/components/chat/reading-panel';
import { withProjectParam } from '@/lib/with-project-param';

/** 파일 타입 글리프 — getFileIcon 결과를 createElement 로 직접 렌더(render 중 컴포넌트 생성 lint 회피). */
function fileGlyph(contentType: string | null, className: string) {
  return createElement(getFileIcon(contentType), { className });
}

interface AssetEmbedCardProps {
  entityId: string;
  /** 토큰 라벨(`[name](entity:asset:id)`의 name) — fetch 전/실패 시 폴백 표시명. */
  label: string;
  /**
   * story #2781 — 채팅 컨텍스트(제공됨)에서는 클릭이 `/storage` 이탈 대신 우측 ReadingPanel의
   * FileViewer를 연다(#2766·#2780과 같은 패턴 — «채팅을 벗어나지 않는다»의 마지막 사각).
   * 미제공(채팅 밖 호출부)이면 기존 `<Link>` 이동 그대로(회귀 0).
   */
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void;
}

/**
 * S6 — 채팅 메시지 내 스토리지 자산 임베드 카드(목업 ② 1:1).
 * `/api/assets/{id}`로 단건 메타(name·content_type·size_bytes) 조회 →
 * 썸네일(타입 틴트 글리프) + 이름 + 메타 + 외부링크 화살표. 링크 `/storage?asset={id}`.
 * 로딩=스켈레톤·미존재(fetch 실패/404)=graceful(평문 라벨, 링크/화살표 제거).
 */
export function AssetEmbedCard({ entityId, label, onOpenReadingPanel }: AssetEmbedCardProps) {
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
        const r = await fetchWithAuth(`/api/assets/${entityId}`);
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

  // story 4831: 내 메시지 버블은 밝은 틴트(bg-proof-blue-soft)+어두운 ink(story #2921)인데 옛 코드는 «진한 brand 버블 위 화이트 카드»라 흰 글자 · 흰 반투명을 썼다(라이트에서 안 보임).
  // 내 메시지 위에서도 다른 카드와 같은 표면(card)을 쓴다 — 이미 대비가 검증된 조합이고, 특수 가지가 없으니 한 곳에서 정한다. 그래서 «내 메시지 여부» 인자는 걷었다(story 4831).
  const cardSurface = 'border-border bg-card hover:bg-muted';
  const nameTone = 'text-foreground';
  const metaTone = 'text-muted-foreground';
  const arrowTone = 'text-muted-foreground';

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
      <div className="mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border border-border bg-muted/40 px-2.5 py-2">
        <span className="grid size-[38px] shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
          {fileGlyph(null, 'size-[17px]')}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-xs font-semibold ${nameTone}`}>{label}</p>
          <p className={`mt-px text-editorial-meta ${metaTone}`}>{t('assetEmbedMissing')}</p>
        </div>
      </div>
    );
  }

  // ── 로드 완료: 썸네일 글리프 + 이름 + 메타 + 화살표 ──
  const tint = FILE_TINT_CLASS[fileTypeTint(asset.content_type)];
  const ext = fileExtLabel(asset.content_type, asset.name);
  const meta = `${ext} · ${formatFileSize(asset.size_bytes)}`;

  const inner = (
    <>
      {/* 썸네일 38×38 — 타입 틴트 글리프(서명 썸네일 필드 부재 → 글리프, 추후 affordance). */}
      <span className={`grid size-[38px] shrink-0 place-items-center overflow-hidden rounded-sm ${tint}`}>
        {fileGlyph(asset.content_type, 'size-[17px]')}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-xs font-semibold ${nameTone}`}>{asset.name}</p>
        <p className={`mt-px text-editorial-meta ${metaTone}`}>{meta}</p>
      </div>
      <ExternalLink className={`size-[15px] shrink-0 ${arrowTone}`} aria-hidden />
    </>
  );

  if (onOpenReadingPanel) {
    return (
      <button
        type="button"
        onClick={() =>
          onOpenReadingPanel({ kind: 'attachment', assetId: asset.id, label: asset.name, contentType: asset.content_type })
        }
        className={`mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${cardSurface}`}
      >
        {inner}
      </button>
    );
  }

  return (
    <Link
      // story #4231 4차 B — 채팅 임베드는 다른 프로젝트 자산일 수 있다 → 자산 자기 project_id(현재 p 아님).
      href={withProjectParam(`/storage?asset=${asset.id}`, asset.project_id ?? null)}
      className={`mt-2 flex max-w-[300px] items-center gap-2.5 rounded-md border px-2.5 py-2 no-underline transition-colors ${cardSurface}`}
    >
      {inner}
    </Link>
  );
}
