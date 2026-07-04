'use client';

import { useCallback, useEffect, useState } from 'react';
import { ImageOff, Loader2, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type ImageState = 'loading' | 'ok' | 'no-access' | 'phantom';

/** 짧은 copy(CTA/헤드라인)는 전문, 이보다 길면 line-clamp+더보기(handoff §2). */
const SHORT_COPY_THRESHOLD = 60;

/**
 * image/* 프리뷰 — StorageThumbnail(components/storage)과 달리 source_links 기반 sign-plan을
 * 거치지 않는다(방금 생성된 loop artifact asset은 source_links가 비어있는 게 정상, S6 §4-2).
 * asset_id 직접 sign — BE attachments/authorize가 project-scope로 권위 판정하므로 안전.
 */
function ImagePreview({ assetId, fallbackLabel }: { assetId: string; fallbackLabel: string }) {
  const t = useTranslations('storage');
  const [state, setState] = useState<ImageState>('loading');
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const signRes = await fetch(`/api/attachments/sign?asset_id=${assetId}`);
        if (cancelled) return;
        if (signRes.status === 403) { setState('no-access'); return; }
        if (!signRes.ok) { setState('no-access'); return; }
        const json = (await signRes.json()) as { data?: { url?: string } };
        const url = json.data?.url;
        if (!url) { setState('no-access'); return; }
        setSignedUrl(url);
        setState('ok');
      } catch {
        if (!cancelled) setState('no-access');
      }
    })();
    return () => { cancelled = true; };
  }, [assetId]);

  if (state === 'loading') {
    return (
      <div className="absolute inset-0">
        <Skeleton className="absolute inset-0 rounded-none" />
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 className="size-5 animate-spin text-info" aria-label={t('previewLoading')} />
        </div>
      </div>
    );
  }
  if (state === 'no-access') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-3 text-center text-muted-foreground">
        <Lock className="size-5" aria-hidden />
        <span className="text-[10px] font-medium">{t('previewNoAccessTitle')}</span>
      </div>
    );
  }
  if (state === 'ok' && signedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={signedUrl}
        alt={fallbackLabel}
        onError={() => setState('phantom')}
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted px-3 text-center text-muted-foreground">
      <ImageOff className="size-5" aria-hidden />
      <span className="line-clamp-2 text-[10px] font-medium">{fallbackLabel}</span>
    </div>
  );
}

/**
 * text/* 프리뷰 — text_content(≤4KB)가 LoopArtifactResponse에 이미 실려오므로 fetch 없이
 * 동기 렌더이 기본. textTruncated(원본 >4KB)일 때만 "더보기"가 GET /api/assets/{id}/text로
 * 전문을 lazy refetch(S24b fast-follow, 디디 endpoint) — <4KB(대다수)는 순수 클라이언트
 * line-clamp 토글 그대로(회귀0). 실패(503 등)는 캡된 textContent를 유지한 채 재시도 affordance.
 */
function TextPreview({
  assetId,
  textContent,
  textTruncated,
}: {
  assetId: string;
  textContent: string;
  textTruncated: boolean;
}) {
  const t = useTranslations('storage');
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullTextError, setFullTextError] = useState(false);
  const isLong = textContent.length > SHORT_COPY_THRESHOLD;
  const displayText = fullText ?? textContent;

  const fetchFullText = useCallback(async () => {
    setLoadingFull(true);
    setFullTextError(false);
    try {
      const res = await fetch(`/api/assets/${assetId}/text`);
      if (!res.ok) { setFullTextError(true); return; }
      const { data } = (await res.json()) as { data?: { text_content?: string } };
      if (!data?.text_content) { setFullTextError(true); return; }
      setFullText(data.text_content);
      setExpanded(true);
    } catch {
      setFullTextError(true);
    } finally {
      setLoadingFull(false);
    }
  }, [assetId]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (textTruncated && fullText === null) { void fetchFullText(); return; }
    setExpanded((v) => !v);
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-y-auto bg-muted/30 px-3 py-2 text-center">
      <p
        className={cn(
          'text-[13px] font-semibold leading-snug text-foreground',
          isLong && !expanded && 'line-clamp-3 text-[11.5px] font-normal',
        )}
      >
        {displayText}
      </p>
      {isLong ? (
        <button
          type="button"
          onClick={handleToggle}
          disabled={loadingFull}
          className="text-[10px] font-semibold text-primary hover:underline disabled:opacity-50"
        >
          {loadingFull ? t('previewLoading') : expanded ? t('previewCollapse') : t('previewExpand')}
        </button>
      ) : null}
      {fullTextError ? (
        <button type="button" onClick={handleToggle} className="text-[9px] font-medium text-destructive hover:underline">
          {t('errorDesc')} · {t('retry')}
        </button>
      ) : textTruncated && fullText === null ? (
        <span className="text-[9px] text-muted-foreground">{t('previewTruncatedNote')}</span>
      ) : null}
    </div>
  );
}

function TypeChipFallback({ contentType, fallbackLabel }: { contentType: string; fallbackLabel: string }) {
  const subtype = contentType.split('/')[1] ?? contentType;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted px-3 text-center text-muted-foreground">
      <span className="line-clamp-2 text-[10px] font-medium">{fallbackLabel}</span>
      <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
        {subtype}
      </span>
    </div>
  );
}

function renderByContentType(
  contentType: string,
  assetId: string,
  fallbackLabel: string,
  textContent: string | null,
  textTruncated: boolean,
) {
  if (contentType.startsWith('image/')) {
    return <ImagePreview assetId={assetId} fallbackLabel={fallbackLabel} />;
  }
  if (contentType.startsWith('text/') && textContent) {
    return <TextPreview assetId={assetId} textContent={textContent} textTruncated={textTruncated} />;
  }
  // 기타 type(video 등) 또는 text/*인데 text_content 없음(null-safe 폴백) — label+chip.
  return <TypeChipFallback contentType={contentType} fallbackLabel={fallbackLabel} />;
}

/**
 * BE가 아직 content_type을 LoopArtifactResponse에 안 실어주는 과도기(S24 병행 배포 중) 대응 —
 * S6 시절처럼 /api/assets/{id}를 별도로 조회해 content_type만 얻는다(text_content는 이 경로로
 * 안 옴 — old asset 응답엔 없음 — 그래서 text/*로 판정돼도 TypeChipFallback으로 떨어져 S24
 * 이전과 동일한 라벨-only 동작을 유지한다. image/*만 실 프리뷰, 나머지는 무조건 안전).
 */
function LegacyContentTypeFallback({ assetId, fallbackLabel }: { assetId: string; fallbackLabel: string }) {
  const [resolvedType, setResolvedType] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/assets/${assetId}`);
        if (cancelled) return;
        if (!res.ok) { setFailed(true); return; }
        const { data } = (await res.json()) as { data?: { content_type?: string } };
        if (cancelled) return;
        if (!data?.content_type) { setFailed(true); return; }
        setResolvedType(data.content_type);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [assetId]);

  if (failed) return <TypeChipFallback contentType="application/octet-stream" fallbackLabel={fallbackLabel} />;
  if (!resolvedType) {
    return (
      <div className="absolute inset-0">
        <Skeleton className="absolute inset-0 rounded-none" />
      </div>
    );
  }
  return <>{renderByContentType(resolvedType, assetId, fallbackLabel, null, false)}</>;
}

/**
 * E-LOOP-LEDGER S24 — variant 카드 미리보기, content_type 분기(handoff §2/render doc).
 * image/* → 기존 서명URL sign+fetch 경로(회귀0). text/* → text_content 인라인(엑박 근절,
 * S6 §4-2 갭 해소) — LoopArtifactResponse에 이미 실려오므로 별도 fetch 없음(N+1 개선 부수효과).
 * 기타 → label+content_type chip 폴백(video 등, graceful, 엑박 근절).
 *
 * ⚠️ contentType이 빈 값(디디 BE가 S24 필드를 아직 안 실어주는 과도기)이면 LegacyContentTypeFallback
 * 으로 떨어져 S24 이전과 동일하게 동작한다 — 크로스-PR 배포 순서 무관 회귀0(까심 재현 대비).
 */
export function ArtifactPreview({
  assetId,
  fallbackLabel,
  contentType,
  textContent,
  textTruncated,
}: {
  assetId: string;
  fallbackLabel: string;
  contentType: string | null | undefined;
  textContent: string | null;
  textTruncated: boolean;
}) {
  if (!contentType) {
    return <LegacyContentTypeFallback assetId={assetId} fallbackLabel={fallbackLabel} />;
  }
  return <>{renderByContentType(contentType, assetId, fallbackLabel, textContent, textTruncated)}</>;
}
