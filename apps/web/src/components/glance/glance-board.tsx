'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Loader2, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import type { RoadmapEpic } from '@/services/glance';
import { loadGlanceData } from './load-glance-data';
import { RoadmapFlow } from './roadmap-flow';
import { GlanceHero } from './glance-hero';
import { GlanceEpicList } from './glance-epic-list';
import { ExceptionStream } from './exception-stream';
import {
  toExceptionQueueItems,
  type BeAttentionSignal,
  type ExceptionLabels,
} from './derive-exception-signals';
import type { HeroEnvelope } from './derive-hero-envelope';
import type { HeroStory, HeroMember } from './hero-logic';

// story 190f4c71(doc resource-view-firsttouch-identity-pattern §4 "현황판(glance)" 행 — 정체성=
// 프로젝트 여정[시작→지금→앞으로]·visual=로드맵 waypoint·첫행동=첫 에픽): 3-waypoint **직선** 배치.
// 실험실(1eb18bd8)의 4노드 원형 사이클과 의도적으로 differentiate — 현황판은 사이클이 아니라
// 선형 여정(journey)이라 원 아닌 직선. 과설명 금지·아이콘 없이 라벨+점만(더 절제).
function RoadmapWaypoints({ t }: { t: (key: 'roadmapWaypointStart' | 'roadmapWaypointNow' | 'roadmapWaypointFuture') => string }) {
  const points: Array<{ key: 'roadmapWaypointStart' | 'roadmapWaypointNow' | 'roadmapWaypointFuture'; emphasis?: boolean }> = [
    { key: 'roadmapWaypointStart' },
    { key: 'roadmapWaypointNow', emphasis: true },
    { key: 'roadmapWaypointFuture' },
  ];
  return (
    <div className="flex items-center gap-2 text-muted-foreground/70" aria-hidden="true">
      {points.map(({ key, emphasis }, i) => (
        <span key={key} className="flex items-center gap-2">
          {i > 0 ? <span className="h-px w-8 bg-border" /> : null}
          <span className="flex flex-col items-center gap-1">
            <span className={emphasis ? 'size-2 rounded-full bg-info' : 'size-1.5 rounded-full bg-muted-foreground/40'} />
            <span className="text-[10px] leading-none">{t(key)}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

interface GlanceBoardProps {
  projectId: string;
  className?: string;
}

/**
 * E-GLANCE 2D 재설계(story dee92c96) — "Focus + Legible Roadmap". 3D 폐기: 초점은 **크기/위계**로
 * (perspective/blur 0)·전 항목 legible(글랜스 본분=한눈에 읽힘). 레이아웃 4요소: ①에디토리얼 타이틀
 * ②로드맵 스파인(RoadmapFlow 그대로) ③hero=현재 에픽 **활성 story**의 실 Proof Capsule ④우측 legible
 * 리스트 + 예외 스트림. no-fiction(에픽 레벨 claim/evidence 발명 0)·감시 아니라 신뢰. 신규 라우트 0.
 */
export function GlanceBoard({ projectId, className }: GlanceBoardProps) {
  const t = useTranslations('glance');
  const [roadmap, setRoadmap] = useState<RoadmapEpic[]>([]);
  const [totalEpicCount, setTotalEpicCount] = useState(0);
  const [activeEpicTitle, setActiveEpicTitle] = useState<string | null>(null);
  const [heroStory, setHeroStory] = useState<HeroStory | null>(null);
  const [heroEnvelope, setHeroEnvelope] = useState<HeroEnvelope | null>(null);
  const [memberMap, setMemberMap] = useState<Record<string, HeroMember>>({});
  const [attentionSignals, setAttentionSignals] = useState<BeAttentionSignal[]>([]);
  const [loading, setLoading] = useState(true);

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
          setActiveEpicTitle(data.activeEpicTitle);
          setHeroStory(data.heroStory);
          setHeroEnvelope(data.heroEnvelope);
          setMemberMap(data.memberMap);
          setAttentionSignals(data.attentionSignals);
        }
      } catch {
        // epics fetch 실패(load-glance-data.ts) — 조용히 빈 상태로 유지, 크래시시키지 않음.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const activeEpic = roadmap.find((e) => e.roadmapStatus === 'active') ?? null;
  const restEpics = roadmap.filter((e) => e.id !== activeEpic?.id);

  // 예외 스트림 렌더 항목 — 순수 매퍼(derive-exception-signals)에 i18n 라벨(glance 네임스페이스)만 주입.
  const exceptionItems = useMemo(() => {
    const labels: ExceptionLabels = {
      kind: {
        gate_pending: t('exceptionKindGatePending'),
        blocked: t('exceptionKindBlocked'),
        merge_ready: t('exceptionKindMergeReady'),
      },
      action: {
        gate_pending: t('exceptionActionGatePending'),
        blocked: t('exceptionActionBlocked'),
        merge_ready: t('exceptionActionMergeReady'),
      },
    };
    return toExceptionQueueItems(attentionSignals, labels);
  }, [attentionSignals, t]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('loading')}
      </div>
    );
  }

  if (roadmap.length === 0) {
    return (
      <EmptyState
        icon={<Compass className="size-8" />}
        title={t('roadmapEmpty')}
        description={t('roadmapEmptyDescription')}
        action={
          <div className="flex flex-col items-center gap-4">
            <RoadmapWaypoints t={t} />
            <div className="flex flex-col items-center gap-1.5">
              <Button size="sm" asChild>
                <Link href="/epics">{t('roadmapEmptyCta')}</Link>
              </Button>
              <p className="text-xs text-muted-foreground">{t('roadmapEmptyAiHint')}</p>
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div className={className}>
      <div className="space-y-6">
        {/* ① 에디토리얼 타이틀 — 대형 타이포 = 초점 위계(3D 없이). */}
        <h1 className="text-2xl font-extrabold leading-[1.1] tracking-tight text-foreground sm:text-[32px]">
          {activeEpicTitle ? t('boardChapterActive', { epic: activeEpicTitle }) : t('boardChapterIdle')}
        </h1>

        {/* ② 로드맵 스파인 — RoadmapFlow 그대로 재사용(전 노드 legible·blur/3D 0). */}
        <RoadmapFlow epics={roadmap} totalEpicCount={totalEpicCount} />

        {/* ③ hero + ④ 우측(legible 리스트 + 예외 스트림). 비율 1.32:1(목업)·모바일 스택. */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.32fr_1fr]">
          <div>
            {heroStory ? (
              <GlanceHero story={heroStory} memberMap={memberMap} envelope={heroEnvelope} />
            ) : (
              // 활성 story 없음 = 평온 빈상태(억지 렌더 0·no-fiction).
              <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {t('heroEmpty')}
              </p>
            )}
          </div>

          <div className="space-y-5">
            <GlanceEpicList epics={restEpics} />
            <div>
              <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                {t('exceptionsTitle')}
              </p>
              {/* #2097 glance/attention 실신호 배선(story 0441a197) — 없으면 정직 빈상태. */}
              <ExceptionStream items={exceptionItems} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
