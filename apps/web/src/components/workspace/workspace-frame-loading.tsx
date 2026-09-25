'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceFrameTabs, type WorkspaceFrameTabKey } from './workspace-frame-tabs';

/**
 * story #4274(PO · 유나 스트리밍 대조) — 일감 프레임 여섯 경로(목록 · 보드 · 스프린트 · 에픽 · 회고 · 가설)의 loading 스켈레톤.
 * 탭 줄(WorkspaceFrameTabs)은 각 화면 안에 있어서, 로딩 경계가 뜨는 동안 일반 스켈레톤만 그리면 탭 줄이 사라졌다 돌아왔다
 * (보드 → 목록 ~290ms · 보드 → 스프린트 ~1.4s). 경계가 탭 줄을 품어 형제 이동 때 탭 줄이 제자리에 그대로 남게 한다.
 *
 * `layout`은 각 화면이 탭 줄을 두는 자리와 같게:
 * - `inset`: `space-y-* p-4` 안 첫 줄(보드 flow-client · 목록 work-list-shell · 에픽 epic-swimlane-board · 가설 hypotheses-list-shell)
 * - `sticky`: `sticky top-0 px-6 pt-3` 띠(스프린트 sprints-client · 회고 retro/page)
 */
/** 탭마다 화면이 탭 줄을 두는 자리(위 `layout` 설명) — 부모 `[ws]/[proj]/loading.tsx`가 도착 경로로 고를 때 쓰는 한 표. */
export const WORKSPACE_FRAME_LOADING_LAYOUT: Record<WorkspaceFrameTabKey, 'inset' | 'sticky'> = {
  workList: 'inset',
  board: 'inset',
  epic: 'inset',
  hypothesis: 'inset',
  sprints: 'sticky',
  retro: 'sticky',
};

export function WorkspaceFrameLoading({ active, layout }: { active: WorkspaceFrameTabKey; layout: 'inset' | 'sticky' }) {
  const t = useTranslations('common');
  const rows = (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 rounded-lg" />
      ))}
    </div>
  );
  if (layout === 'sticky') {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <div className="sticky top-0 z-10 bg-background px-6 pt-3">
          <WorkspaceFrameTabs active={active} />
        </div>
        <div className="p-6">{rows}</div>
      </div>
    );
  }
  return (
    <div className="space-y-4 p-4" role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <WorkspaceFrameTabs active={active} />
      {rows}
    </div>
  );
}
