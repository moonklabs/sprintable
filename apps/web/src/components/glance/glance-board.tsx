'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import type { BeActivityLogItem, EpicCollaboration, RoadmapEpic } from '@/services/glance';
import { loadGlanceData } from './load-glance-data';
import { RoadmapFlow } from './roadmap-flow';
import { ProgressTrajectory } from './progress-trajectory';
import { CollaborationMap } from './collaboration-map';
import { LiveStream } from './live-stream';

interface GlanceBoardProps {
  projectId: string;
  className?: string;
}

/**
 * E-GLANCE C1 현황판 오케스트레이터 — 실 fetch, mock 폴백 0. 서브 컴포넌트(RoadmapFlow 등)는
 * 전부 순수 props라 여기서만 §10 데이터 소스 4종을 병합한다(실 fetch는 `load-glance-data.ts`).
 * 아무 데이터도 없으면(신규 프로젝트 등) 로드맵 자체가 빈 배열 — §9 매트릭스의 calm 빈 상태.
 */
export function GlanceBoard({ projectId, className }: GlanceBoardProps) {
  const t = useTranslations('glance');
  const [roadmap, setRoadmap] = useState<RoadmapEpic[]>([]);
  const [totalEpicCount, setTotalEpicCount] = useState(0);
  const [collaboration, setCollaboration] = useState<EpicCollaboration[]>([]);
  const [events, setEvents] = useState<BeActivityLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await loadGlanceData(projectId);
        if (!cancelled) {
          setRoadmap(data.roadmap);
          setTotalEpicCount(data.totalEpicCount);
          setCollaboration(data.collaboration);
          setEvents(data.events);
          setLoadedAt(Date.now());
        }
      } catch {
        // epics fetch 실패(load-glance-data.ts 참고) — 조용히 빈 상태로 유지, 크래시시키지 않음.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const activeEpic = roadmap.find((e) => e.roadmapStatus === 'active') ?? null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('loading')}
      </div>
    );
  }

  if (roadmap.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t('roadmapEmpty')}</p>;
  }

  return (
    <div className={className}>
      <div className="space-y-4">
        <SectionCard>
          <SectionCardHeader>
            <div className="text-sm font-semibold text-foreground">{t('roadmapTitle')}</div>
          </SectionCardHeader>
          <SectionCardBody>
            <RoadmapFlow epics={roadmap} totalEpicCount={totalEpicCount} />
          </SectionCardBody>
        </SectionCard>

        {activeEpic ? (
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-foreground">{t('progressTitle')}</div>
            </SectionCardHeader>
            <SectionCardBody>
              <ProgressTrajectory epic={activeEpic} />
            </SectionCardBody>
          </SectionCard>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-foreground">{t('collaborationTitle')}</div>
            </SectionCardHeader>
            <SectionCardBody>
              <CollaborationMap roadmap={roadmap} collaboration={collaboration} />
            </SectionCardBody>
          </SectionCard>
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-foreground">{t('liveStreamTitle')}</div>
            </SectionCardHeader>
            <SectionCardBody>
              <LiveStream events={events} now={loadedAt} />
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
