'use client';

import { useTranslations } from 'next-intl';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { GlanceBoard } from '@/components/glance/glance-board';

export default function GlancePage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('glance');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return (
    // story #2001: 이 루트가 `mx-auto`(shrink-to-fit)라 RoadmapFlow의 shrink-0 가로 콘텐츠(min-content)가
    // 뷰포트를 넘으면 shrink-to-fit 계산이 min-width:0만으로는 클램프되지 않고 루트 자체가 넓어져
    // (실측 460→492px vs 뷰포트 390px) 내부 overflow-x-auto가 무력화됐다 — w-full로 shrink-to-fit
    // 자체를 우회(명시적 100%는 flex/grid 조상 체인의 fit-content 계산과 무관하게 부모 폭을 그대로 따름).
    <div className="w-full min-w-0 mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('pageDescription')}</p>
      </div>
      <GlanceBoard projectId={projectId} />
    </div>
  );
}
