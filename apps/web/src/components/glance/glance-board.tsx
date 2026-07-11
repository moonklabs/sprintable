'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import type { BeActivityLogItem, EpicCollaboration, RoadmapEpic } from '@/services/glance';
import { getCachedGlanceData, loadGlanceData, type GlanceData } from './load-glance-data';
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
 * 전부 순수 props라 여기서만 §10 데이터 소스 4종을 병합한다: /api/epics(순서 SSOT) ·
 * /api/dashboard/overview(진척) · /api/stories?epic_id=(참여) · /api/activity-logs(생동).
 * 아무 데이터도 없으면(신규 프로젝트 등) 로드맵 자체가 빈 배열 — §9 매트릭스의 calm 빈 상태.
 * 실 fetch 자체는 `load-glance-data.ts`(module-level dedupe) — 재마운트 레이스 fix 이유는 그쪽 주석.
 */
function applyGlanceData(
  data: GlanceData,
  setRoadmap: (v: RoadmapEpic[]) => void,
  setTotalEpicCount: (v: number) => void,
  setCollaboration: (v: EpicCollaboration[]) => void,
  setEvents: (v: BeActivityLogItem[]) => void,
  setLoadedAt: (v: number) => void,
) {
  setRoadmap(data.roadmap);
  setTotalEpicCount(data.totalEpicCount);
  setCollaboration(data.collaboration);
  setEvents(data.events);
  setLoadedAt(Date.now());
}

export function GlanceBoard({ projectId, className }: GlanceBoardProps) {
  const t = useTranslations('glance');
  // 마운트 시 동기 캐시 읽기 — 재마운트 레이스 근본 fix(#2053 2차, load-glance-data.ts 주석 참고).
  // useState 초기값은 첫 렌더에서만 쓰이므로, 재마운트된 새 인스턴스마다 새로 평가돼 그 시점의
  // 캐시를 반영한다(await 없이 즉시 커밋 — 취소될 여지 자체가 없다).
  const initial = getCachedGlanceData(projectId);
  const [roadmap, setRoadmap] = useState<RoadmapEpic[]>(initial?.roadmap ?? []);
  const [totalEpicCount, setTotalEpicCount] = useState(initial?.totalEpicCount ?? 0);
  const [collaboration, setCollaboration] = useState<EpicCollaboration[]>(initial?.collaboration ?? []);
  const [events, setEvents] = useState<BeActivityLogItem[]>(initial?.events ?? []);
  const [loading, setLoading] = useState(!initial);
  const [loadedAt, setLoadedAt] = useState(initial ? Date.now() : 0);

  useEffect(() => {
    if (!projectId) return;
    // projectId가 바뀐 기존 인스턴스(재마운트 아님)도 새 프로젝트의 캐시를 즉시 반영 — 없으면
    // 로딩으로 리셋(이전 프로젝트 데이터가 새 프로젝트인 척 잔존하지 않도록).
    const cachedNow = getCachedGlanceData(projectId);
    if (cachedNow) {
      applyGlanceData(cachedNow, setRoadmap, setTotalEpicCount, setCollaboration, setEvents, setLoadedAt);
      setLoading(false);
    } else {
      setRoadmap([]);
      setTotalEpicCount(0);
      setCollaboration([]);
      setEvents([]);
      setLoading(true);
    }

    let cancelled = false;
    void (async () => {
      try {
        const data = await loadGlanceData(projectId);
        // 이 인스턴스가 살아있으면 즉시 반영(최신 데이터로 갱신) — 죽었어도 load-glance-data.ts가
        // 이미 캐시에 써놨으므로 다음 마운트가 동기 읽기로 성공한다(위 주석 핵심).
        if (!cancelled) applyGlanceData(data, setRoadmap, setTotalEpicCount, setCollaboration, setEvents, setLoadedAt);
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
