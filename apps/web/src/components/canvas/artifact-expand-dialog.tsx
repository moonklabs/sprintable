'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ExternalLink, MousePointerClick } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArtifactStage, isResponsiveHtml, RESPONSIVE_PREVIEW_BREAKPOINTS, type ResponsivePreviewBreakpoint } from './artifact-stage';
import { ArtifactGalleryTimeline, type GalleryTimelineVersion } from './artifact-gallery-timeline';
import type { ArtifactFormat } from '@/services/canvas';

type PreviewBreakpoint = ResponsivePreviewBreakpoint | 'desktop';

interface ArtifactExpandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  format: ArtifactFormat;
  content: string;
  /** story 1948d19d §4 — 선언된 아트보드 크기(있으면). 없으면 ArtifactStage가 기본 폴백. */
  canvasBounds?: { w: number; h: number } | null;
  /** story 39313b40 — 갤러리 카드 그리드: 그리드 인라인 펼침 대신 모달 내 버전 탭으로 변천사를
   * 보여준다(reflow 회피, doc §3). 스토리 상세 뷰어(artifact-viewer.tsx)는 이 3개 prop을
   * 생략 → 탭 미노출, 기존 동작 그대로(회귀 0). 재사용: ArtifactGalleryTimeline(갤러리 변천사와
   * 동일 컴포넌트, 신규 UI 0). */
  versions?: GalleryTimelineVersion[];
  selectedVersion?: number;
  onSelectVersion?: (versionNumber: number) => void;
  /** story #3378(결함·customer-zero) — 이 다이얼로그가 막다른 길이었다(닫기·버전 점·전체
   * 보기/실제 크기만, 내보내기·정본 제안·코멘트가 있는 상세로 갈 길 0). 갤러리에서 열 때만
   * 넘긴다 — 이미 상세 페이지 안(artifact-viewer.tsx)에서 열린 다이얼로그는 그 자리로
   * 다시 링크할 이유가 없어 생략(prop 부재=미노출, no-fiction). `/artifacts/{id}`(ws/proj
   * 없는 bare 경로)로 링크하면 proxy.ts의 레거시 리다이렉트(story #3208과 동일 메커니즘)가
   * 이 아티팩트의 실제 소속 project로 직접 해소한다 — 클라에서 ws/proj를 추측하지 않는다. */
  artifactId?: string;
}

/**
 * "크게 보기" 모달(story d425dccc 원조·story 3d888ba2에서 스토리 상세 뷰어와 갤러리가 공유하도록
 * 추출·story 1948d19d에서 ArtifactStage가 캔버스 뷰포트로 재작성되며 자동 계승) — 큰 표면
 * (≈90vw×85vh)에서 같은 ArtifactStage를 재렌더. ArtifactStage는 이제 자기 컨테이너 크기를
 * 그대로 채우는 캔버스 뷰포트라 별도 "fill 모드" 개념이 없다 — CSS로 큰 박스를 주면 그게 곧
 * 큰 뷰포트다(인라인 카드도 동일 컴포넌트, 크기만 다름). 신규 뷰어 0 — 기존 컴포넌트 재사용.
 */
export function ArtifactExpandDialog({
  open, onOpenChange, title, format, content, canvasBounds, versions, selectedVersion, onSelectVersion, artifactId,
}: ArtifactExpandDialogProps) {
  const t = useTranslations('canvas');
  // story 3d0d60a3 — 반응형 미리보기. @media 판정=html 포맷에서만(유나 1순위·값싼 소스 파싱,
  // 신규 BE 0). 판정 실패(고정폭)면 셀렉터 자체를 렌더하지 않는다(disabled 아님·부재 — no-fiction).
  const showBreakpointSelector = format === 'html' && isResponsiveHtml(content);
  const [breakpoint, setBreakpoint] = useState<PreviewBreakpoint>('desktop');
  // 다른 버전/아트팩트로 전환되면 이전 브레이크포인트 선택이 새 콘텐츠에 그대로 남아있을
  // 이유가 없다 — 매번 데스크톱(=원본 canvas_bounds)으로 리셋. effect가 아니라 렌더 중 조정
  // (React 공식 "prop 변경 시 state 리셋" 패턴) — set-state-in-effect lint 대상이 아니다.
  const [prevContent, setPrevContent] = useState(content);
  // story #3377(결함·customer-zero) — 캔버스 인라인 스테이지는 pan/드래그 설계 보존을 위해
  // 항상 클릭을 안 받지만(ArtifactStage htmlInteractive 기본 false), 이 다이얼로그는 pan
  // 캔버스로 안 쓰이므로(overlay 미사용) html_blob에서 기본 ON — PO 확定(2026-09-03).
  const [htmlInteractive, setHtmlInteractive] = useState(format === 'html');
  if (content !== prevContent) {
    setPrevContent(content);
    setBreakpoint('desktop');
    // 다른 아티팩트로 전환되면 이전 상호작용 토글이 새 콘텐츠에 새지 않도록 기본값(해당
    // 포맷이 html이면 ON)으로 되돌린다 — 위 브레이크포인트 리셋과 동일 원칙, 같은 블록.
    setHtmlInteractive(format === 'html');
  }
  const previewWidth = breakpoint === 'desktop' ? undefined : RESPONSIVE_PREVIEW_BREAKPOINTS[breakpoint];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            // story #3007(로드맵 P2·PR-E, L1) — 다이얼로그는 floating이라 --elev-overlay.
            'rounded-xl bg-card shadow-[var(--elev-overlay)] ring-1 ring-foreground/10 outline-none',
            'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
            'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="truncate text-sm font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            {/* 유나 design verdict(41e70eee7) — 오른쪽 정렬 액션들이 각자 ml-auto를 가지면
             * flex auto 마진이 남은 공간을 나눠 가져 가운데로 뜬다. ml-auto는 이 그룹
             * 컨테이너 하나에만 두고, 안의 형제들은 gap으로만 벌린다(항목이 늘어도 안전). */}
            <div className="ml-auto flex items-center gap-2">
              {artifactId ? (
                <Link
                  href={`/artifacts/${artifactId}`}
                  title={t('artifactDetailPageLinkHint')}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink className="size-3" aria-hidden />
                  {t('artifactDetailPageLink')}
                </Link>
              ) : null}
              {format === 'html' ? (
                <button
                  type="button"
                  onClick={() => setHtmlInteractive((v) => !v)}
                  aria-pressed={htmlInteractive}
                  title={t(htmlInteractive ? 'artifactInteractiveOnHint' : 'artifactInteractiveOffHint')}
                  className={cn(
                    'flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
                    htmlInteractive
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <MousePointerClick className="size-3" aria-hidden />
                  {t(htmlInteractive ? 'artifactInteractiveOn' : 'artifactInteractiveOff')}
                </button>
              ) : null}
              <DialogPrimitive.Close
                className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t('closeAction')}
              </DialogPrimitive.Close>
            </div>
          </div>
          {showBreakpointSelector ? (
            <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-4 py-2">
              {(['desktop', 'tablet', 'mobile'] as const).map((bp) => (
                <button
                  key={bp}
                  type="button"
                  onClick={() => setBreakpoint(bp)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                    breakpoint === bp ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`responsivePreview${bp[0]!.toUpperCase()}${bp.slice(1)}`)}
                </button>
              ))}
            </div>
          ) : null}
          {versions && versions.length > 1 ? (
            <ArtifactGalleryTimeline
              versions={versions}
              selectedVersion={selectedVersion}
              onSelectVersion={onSelectVersion}
              className="shrink-0 border-b border-border px-4 py-2.5"
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <ArtifactStage
              format={format} content={content} title={title} canvasBounds={canvasBounds} previewWidth={previewWidth}
              htmlInteractive={format === 'html' && htmlInteractive}
            />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
