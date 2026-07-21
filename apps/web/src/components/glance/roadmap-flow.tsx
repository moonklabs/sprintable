'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapEpic } from '@/services/glance';

interface RoadmapFlowProps {
  epics: RoadmapEpic[];
  /** 전체 에픽 개수(스코프 창 밖 포함) — 유나 "현재 궤적" 서사: 창 밖 히스토리가 있으면
   * "전체 N개 중 여기"만 성기게 언급(§9 "지난 여정"은 온디맨드 secondary, 지금은 미니 컨텍스트만). */
  totalEpicCount?: number;
  className?: string;
}

/**
 * E-GLANCE §3 로드맵 흐름 — 노드+커넥터 타임라인. 시각 SSOT(`e-glance-glance-board-mockup-render`)
 * §① 그대로: 완료 노드는 success 채움+체크, 진행 노드는 info 채움+링 글로우+"● 여기" 마커,
 * 예정 노드는 muted 아웃라인. 커넥터는 완료 구간만 success로 채워져 "여기까지 왔다"를 표현.
 * 주어=프로젝트: "6개 중 3번째"(개인/시간 지연 강조 0). §3 "마일스톤 클릭 → 해당 에픽
 * 상세… 로드맵은 요약·드릴다운은 링크" — 각 마일스톤이 `/epics/{id}`로 드릴다운.
 *
 * "현재 궤적"(current-arc) — 유나 로드맵 서사 확定(b), 2026-07-10: `epics`는 이미
 * `scopeRoadmapEpics()`가 active(들)를 anchor로 앞뒤 소수만 window한 결과(glance.ts 참고).
 * 전체 히스토리가 이보다 많으면(`totalEpicCount > epics.length`) 조용히 "전체 N개 중" 컨텍스트만
 * 덧붙인다(개수 노출이되 "지연/누락" 낙인 아닌 중립 정보 — §1 리트머스 유지).
 */
export function RoadmapFlow({ epics, totalEpicCount, className }: RoadmapFlowProps) {
  const t = useTranslations('glance');
  const activeNodeRef = useRef<HTMLAnchorElement>(null);

  // story #2001: 유나 UX 확定(overflow-x-auto) 보강② — "어디 왔나"가 이 컴포넌트의 요약 핵심이라
  // active 노드가 마운트 시 이미 스크롤 뷰포트 안에 있어야 한다(수동 스크롤 요구 금지).
  // kanban 스와이프(0d142311)와 동형: 네이티브 스크롤 컨테이너 그대로 두고 자식만 조정.
  useEffect(() => {
    activeNodeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, []);

  if (epics.length === 0) return null;

  const activeIndex = epics.findIndex((e) => e.roadmapStatus === 'active');
  const currentIndex = activeIndex >= 0 ? activeIndex : epics.length - 1;

  return (
    <div className={className}>
      {/* story #2001: 유나 UX 확定 — 로드맵=시간/순서 은유라 wrap(연결선 끊김)·세로스택(glance
          높이 잠식) 대신 가로스크롤. 보강③ 양끝 페이드로 "더 있음" 스크롤 발견성 신호(relative
          wrapper + pointer-events-none 그라데이션 오버레이, from-background로 페이지 배경과 합성). */}
      <div className="relative">
        <div className="focus-inset flex items-start overflow-x-auto">
          {epics.map((e, i) => (
            <div key={e.id} className="flex items-start">
              <Link
                ref={i === currentIndex ? activeNodeRef : undefined}
                href={`/epics/${e.id}`}
                className="flex min-w-[72px] shrink-0 flex-col items-center rounded-md p-1 transition-opacity hover:opacity-75"
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold',
                    e.roadmapStatus === 'done' && 'border-success bg-success/10 text-success',
                    e.roadmapStatus === 'active' && 'border-info bg-info/10 text-info ring-4 ring-info/10',
                    e.roadmapStatus === 'upcoming' && 'border-border bg-muted/30 text-muted-foreground',
                  )}
                >
                  {e.roadmapStatus === 'done' ? <Check className="size-4" aria-hidden="true" /> : null}
                  {e.roadmapStatus === 'active' ? <span className="size-2.5 rounded-full bg-info" aria-hidden="true" /> : null}
                </span>
                <span
                  className={cn(
                    'mt-2 max-w-[88px] truncate text-center text-[10.5px] font-semibold',
                    e.roadmapStatus === 'upcoming' ? 'text-muted-foreground/70' : 'text-muted-foreground',
                  )}
                >
                  {e.title}
                </span>
                {i === currentIndex ? <span className="mt-0.5 text-[9px] font-bold text-info">{t('currentMarker')}</span> : null}
              </Link>
              {i < epics.length - 1 ? (
                <div className={cn('mt-4 h-0.5 w-6 shrink-0', e.roadmapStatus === 'done' ? 'bg-success' : 'bg-border')} aria-hidden="true" />
              ) : null}
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent" aria-hidden="true" />
      </div>
      <p className="mt-3 text-[11.5px] text-foreground">
        {t.rich('roadmapSummary', {
          position: currentIndex + 1,
          total: epics.length,
          b: (chunks) => <b className="text-info">{chunks}</b>,
        })}
      </p>
      {totalEpicCount != null && totalEpicCount > epics.length ? (
        <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
          {t('roadmapArcContext', { total: totalEpicCount })}
        </p>
      ) : null}
    </div>
  );
}
