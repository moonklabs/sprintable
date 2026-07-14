'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
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
}

/**
 * "크게 보기" 모달(story d425dccc 원조·story 3d888ba2에서 스토리 상세 뷰어와 갤러리가 공유하도록
 * 추출·story 1948d19d에서 ArtifactStage가 캔버스 뷰포트로 재작성되며 자동 계승) — 큰 표면
 * (≈90vw×85vh)에서 같은 ArtifactStage를 재렌더. ArtifactStage는 이제 자기 컨테이너 크기를
 * 그대로 채우는 캔버스 뷰포트라 별도 "fill 모드" 개념이 없다 — CSS로 큰 박스를 주면 그게 곧
 * 큰 뷰포트다(인라인 카드도 동일 컴포넌트, 크기만 다름). 신규 뷰어 0 — 기존 컴포넌트 재사용.
 */
export function ArtifactExpandDialog({
  open, onOpenChange, title, format, content, canvasBounds, versions, selectedVersion, onSelectVersion,
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
  if (content !== prevContent) {
    setPrevContent(content);
    setBreakpoint('desktop');
  }
  const previewWidth = breakpoint === 'desktop' ? undefined : RESPONSIVE_PREVIEW_BREAKPOINTS[breakpoint];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-xl bg-card shadow-lg ring-1 ring-foreground/10 outline-none',
            'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
            'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="truncate text-sm font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="ml-auto rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('closeAction')}
            </DialogPrimitive.Close>
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
            <ArtifactStage format={format} content={content} title={title} canvasBounds={canvasBounds} previewWidth={previewWidth} />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
