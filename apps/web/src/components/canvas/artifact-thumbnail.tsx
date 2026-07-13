'use client';

import { useEffect, useRef, useState } from 'react';
import { FileCode2, Image as ImageIcon, Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { adaptArtifactDetail, getArtifactVersionDetail, type ArtifactFormat } from '@/services/canvas';
import { listArtifactExports } from '@/services/canvas-export';

const THUMB_CANVAS_WIDTH = 480;
const THUMB_CANVAS_HEIGHT = 280;

type ThumbnailState =
  | { kind: 'loading' }
  | { kind: 'image'; url: string }
  | { kind: 'live'; content: string }
  | { kind: 'placeholder'; format: ArtifactFormat };

const FORMAT_ICON: Record<ArtifactFormat, typeof FileCode2> = {
  html: FileCode2,
  image: ImageIcon,
  tree: Workflow,
};

interface ArtifactThumbnailProps {
  artifactId: string;
  latestVersionNumber: number;
  anchorVersion: number | null;
  className?: string;
}

/**
 * story 3d888ba2 — 갤러리 그리드 시각 프리뷰. no-fiction 원칙상 가짜 프리뷰(스켈레톤을 "준비 중"
 * 텍스트로 위장 등)는 절대 금지 — 실제로 보여줄 게 없으면 중립 포맷 아이콘으로 정직 표기한다.
 * 우선순위(PO 확定): ① export PNG 있으면 그걸 썸네일(가장 저비용·안정적, 포맷 무관) ② 없으면
 * 실 콘텐츠를 축소 렌더(html=iframe 스케일다운·image=원본 그대로) ③ tree는 PNG 없으면 렌더
 * 수단이 없어 placeholder(트리 미니어처 렌더러는 스코프 밖). 갤러리 요약 목록에는 format이
 * 없어(BE `VisualArtifactSummary`에 필드 자체가 없음 — nodes 기반 파생이라 버전 상세에서만
 * 나옴) PNG 조회와 버전 상세를 병렬로 같이 받아 판정한다. 둘 다 뷰포트 진입 시에만(lazy) —
 * 항목 多 갤러리에서 동시 다발 iframe/fetch를 피한다.
 */
export function ArtifactThumbnail({ artifactId, latestVersionNumber, anchorVersion, className }: ArtifactThumbnailProps) {
  const t = useTranslations('canvas');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // IntersectionObserver 미지원 환경(구형 브라우저)은 lazy 게이트 없이 즉시 in-view로
  // 시작(기능 저하 없이 성능만 양보, 크래시보다 나음) — effect 안에서 동기 setState하는
  // 대신 초기값 자체를 분기해 cascading render를 피한다.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');
  const [state, setState] = useState<ThumbnailState>({ kind: 'loading' });
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setInView(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    void (async () => {
      const targetVersion = anchorVersion ?? latestVersionNumber;
      const [exports, detail] = await Promise.all([
        listArtifactExports(artifactId, targetVersion),
        getArtifactVersionDetail(artifactId, targetVersion),
      ]);
      if (cancelled) return;

      const png = (exports ?? []).find((e) => e.format === 'png' && e.download_url);
      if (png?.download_url) { setState({ kind: 'image', url: png.download_url }); return; }

      if (!detail) { setState({ kind: 'placeholder', format: 'tree' }); return; }
      const { artifact, versions } = adaptArtifactDetail(detail);
      const content = versions[0]?.content;
      if (artifact.format === 'tree' || !content) { setState({ kind: 'placeholder', format: artifact.format }); return; }
      setState(artifact.format === 'image' ? { kind: 'image', url: content } : { kind: 'live', content });
    })();
    return () => { cancelled = true; };
  }, [inView, artifactId, anchorVersion, latestVersionNumber]);

  useEffect(() => {
    if (state.kind !== 'live') return;
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / THUMB_CANVAS_WIDTH));
    measure();
    // ResizeObserver 미지원 환경 — 초기 측정값(또는 fallback 1)으로 정적 유지, 크래시 방지.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.kind]);

  return (
    <div
      ref={wrapperRef}
      data-artifact-thumbnail
      className={cn('shrink-0 overflow-hidden rounded border border-border bg-muted/40', className)}
    >
      {state.kind === 'loading' ? (
        <div className="size-full animate-pulse bg-muted/60" />
      ) : state.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element -- PNG export/artifact content는 외부·동적 URL이라 next/image 도메인 화이트리스트와 안 맞음.
        <img src={state.url} alt="" className="size-full object-cover" />
      ) : state.kind === 'live' ? (
        <div ref={stageRef} className="pointer-events-none size-full" style={{ height: THUMB_CANVAS_HEIGHT * scale }}>
          <iframe
            title=""
            aria-hidden="true"
            tabIndex={-1}
            srcDoc={state.content}
            sandbox=""
            style={{
              width: THUMB_CANVAS_WIDTH, height: THUMB_CANVAS_HEIGHT,
              transform: `scale(${scale})`, transformOrigin: 'top left',
            }}
          />
        </div>
      ) : (
        (() => {
          const Icon = FORMAT_ICON[state.format];
          return (
            <div className="flex size-full flex-col items-center justify-center gap-0.5 text-muted-foreground/60">
              <Icon className="size-4" aria-hidden />
              <span className="text-[8px] font-semibold uppercase tracking-wide">
                {t(`galleryFormat${state.format[0]!.toUpperCase()}${state.format.slice(1)}`)}
              </span>
            </div>
          );
        })()
      )}
    </div>
  );
}
