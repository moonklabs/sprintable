'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { RoadmapEpic } from '@/services/glance';
import { loadGlanceData } from './load-glance-data';
import { RoadmapFlow } from './roadmap-flow';
import { GlanceHero } from './glance-hero';
import { GlanceEpicList } from './glance-epic-list';
import { ExceptionStream } from './exception-stream';
import type { HeroStory, HeroMember } from './hero-logic';

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
  const [memberMap, setMemberMap] = useState<Record<string, HeroMember>>({});
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
          setMemberMap(data.memberMap);
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
              <GlanceHero story={heroStory} memberMap={memberMap} />
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
              {/* v1 = 실 gate-pending/blocked 배선 前 정직 빈상태 폴백. 디디 gate BE 오면 items 주입. */}
              <ExceptionStream />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
