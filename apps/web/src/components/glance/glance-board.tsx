'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import type { EpicProgress } from '@/components/dashboard/command-center/types';
import {
  deriveCollaboration,
  filterMilestoneEvents,
  mergeRoadmap,
  type BeActivityLogItem,
  type BeEpicListItem,
  type BeStoryListItem,
  type EpicCollaboration,
  type RoadmapEpic,
} from '@/services/glance';
import { RoadmapFlow } from './roadmap-flow';
import { ProgressTrajectory } from './progress-trajectory';
import { CollaborationMap } from './collaboration-map';
import { LiveStream } from './live-stream';

interface GlanceBoardProps {
  projectId: string;
  className?: string;
}

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

async function fetchJson(url: string): Promise<unknown> {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

/**
 * E-GLANCE C1 현황판 오케스트레이터 — 실 fetch, mock 폴백 0. 서브 컴포넌트(RoadmapFlow 등)는
 * 전부 순수 props라 여기서만 §10 데이터 소스 4종을 병합한다: /api/epics(순서 SSOT) ·
 * /api/dashboard/overview(진척) · /api/stories?epic_id=(참여) · /api/activity-logs(생동).
 * 아무 데이터도 없으면(신규 프로젝트 등) 로드맵 자체가 빈 배열 — §9 매트릭스의 calm 빈 상태.
 */
export function GlanceBoard({ projectId, className }: GlanceBoardProps) {
  const t = useTranslations('glance');
  const [roadmap, setRoadmap] = useState<RoadmapEpic[]>([]);
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
        const [epicsJson, overviewJson, membersJson, activityJson] = await Promise.all([
          fetchJson(`/api/epics?project_id=${projectId}&limit=100`),
          fetchJson('/api/dashboard/overview'),
          fetchJson('/api/team-members'),
          fetchJson(`/api/activity-logs?project_id=${projectId}&limit=20`),
        ]);

        const epics = unwrap<BeEpicListItem[]>(epicsJson) ?? [];
        const overview = unwrap<{ project_status: { epics: EpicProgress[] } }>(overviewJson);
        const mergedRoadmap = mergeRoadmap(epics, overview?.project_status.epics ?? []);

        const memberRows = unwrap<{ id: string; name: string }[]>(membersJson) ?? [];
        const memberNames: Record<string, string> = {};
        for (const m of memberRows) memberNames[m.id] = m.name;

        const storyLists = await Promise.all(
          mergedRoadmap.map((e) => fetchJson(`/api/stories?epic_id=${e.id}&limit=100`)),
        );
        const stories = storyLists.flatMap((s) => unwrap<BeStoryListItem[]>(s) ?? []);
        const collab = deriveCollaboration(mergedRoadmap.map((e) => e.id), stories, memberNames);

        const activityItems = unwrap<BeActivityLogItem[]>(activityJson) ?? [];
        const milestoneEvents = filterMilestoneEvents(activityItems);

        if (!cancelled) {
          setRoadmap(mergedRoadmap);
          setCollaboration(collab);
          setEvents(milestoneEvents);
          setLoadedAt(Date.now());
        }
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
            <RoadmapFlow epics={roadmap} />
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
