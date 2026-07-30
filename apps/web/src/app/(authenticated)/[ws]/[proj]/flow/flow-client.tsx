'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { ExceptionStream } from '@/components/glance/exception-stream';
import { toExceptionQueueItems, type BeAttentionSignal, type ExceptionLabels } from '@/components/glance/derive-exception-signals';
import { loadGlanceData, type GlanceData } from '@/components/glance/load-glance-data';
import { useIsMobile } from '@/hooks/use-mobile';
import { NextMakerScreen } from '@/components/flow/next-maker-screen';

interface FlowPageClientProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

type FlowView = 'flow' | 'list';

// PO 판정(2026-07-30) — 선생님 원 지시("보드+현황판 통합, `/plan`은 말실수·`/flow`가 그
// 자리")에 따라 07-23 시안(`e15905e8`)의 「갈래|목록」 세그를 되찾는다(IA 개정 때 조용히
// 지워졌던 것 — 유나 지적). `kanban`은 지난 배포분(PR#2691/#2694) 링크가 이미 떠 있을 수 있어
// `list`의 레거시 별칭으로 계속 받는다(URL 하위호환 — 링크가 조용히 깨지지 않는다).
//
// ⛔선생님 재정정(2026-07-30, PR#2696 CI 중에 도착 — 머지 前에 반영) — "현황판" 3번째 칸은
// 지웠다(짓지 않은 게 아니라 "안 짓기로" 확定해 없앤 것). 근거: glance의 다섯 소스가 전부
// 다른 자리로 흡수된다 — goals+focal→좌 레인+①초점 스트립, dashboard/overview 총계→관제
// 범례 statusbar, glance/attention 예외→③관제, team-members 협업맵 재료→③관제의 원인
// 하나로, 진행 궤적→시간축이 대체(따로 안 옮김). activity-logs만 목업 자체가 자리를
// 정하지 않은 유일한 칸이라 판정 대기. 즉 현황판은 "갈래 캔버스가 더 잘 하는 것의 열등한
// 판"이라 보기로도 남지 않는다.
function parseView(raw: string | null): FlowView {
  if (raw === 'list' || raw === 'kanban') return 'list';
  return 'flow';
}

/**
 * story #2224(IA v2.2 §7-3, 유나 정정 2026-07-30) — 통합 화면. ①초점 스트립(GlanceHero, A타입
 * 재사용) ②관제 서랍(ExceptionStream, A타입 재사용) 은 보기와 무관하게 항상 고정 — "전면에서
 * 내린다"는 뜻이 이것이다(보기를 전환해도 이 둘은 그대로 남는다). 보기 전환은 두 칸(갈래|목록)
 * 세그이며 `?view=` 쿼리파라미터가 정본(URL이 상태를 들고 있어 새로고침·공유 가능).
 *
 * PO 판정(2026-07-30, 선생님 정정 반영) — "보드+현황판 통합"의 실제 자리는 `/plan`이 아니라
 * `/flow`였다(`/plan`은 말실수). 남은 본체는 `/glance`·`/board`를 이 화면 «안으로» 들이고
 * 옛 라우트를 죽이는 것 하나 — 오늘은 그 1단계(세그먼트 셸)만: 갈래=이 캔버스(그대로) ·
 * 목록=`KanbanBoard`(그대로 마운트, 라벨만 이동). glance의 다섯 소스는 「현황판」이라는 별도
 * 보기가 아니라 갈래 보기·관제 서랍의 기존 영역에 나눠 얹는다(선생님 재정정 — 진행 궤적은
 * 시간축이 대체해 따로 옮기지 않고, `activity-logs`만 목업 자체가 자리를 정하지 않은 유일한
 * 칸이라 판정 대기) — 이 나눠얹기 자체는 후속 조각.
 */
export default function FlowPageClient({ projectId, wsSlug, projSlug }: FlowPageClientProps) {
  const t = useTranslations('flow');
  const tGlance = useTranslations('glance');
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = parseView(searchParams.get('view'));
  // 유나 지적(2026-07-30) — 모바일은 갈래|칸반 세그를 그리지 않는다(#2225의 갈래·막힘·멈춤
  // 탭이 그 자리를 대신함). CSS로 숨기면 DOM에 둘 다 남아 스크린리더·탭 순서가 겹친다(#2225
  // AC3와 같은 규율) — useIsMobile로 렌더 자체를 가른다. `?view=`는 모바일에서도 URL 정본
  // 그대로라 세그가 없어도 주소로 칸반 진입은 가능하다.
  const isMobile = useIsMobile();

  const [data, setData] = useState<GlanceData | null>(null);
  const [loading, setLoading] = useState(true);

  // ⛔결함 fix(2026-07-31, "다음을 만드는 화면" 착지 — 아티팩트 a920c25f v2) — 예전엔
  // epics-progress-lane을 여기서 따로 fetch해 FlowLane/FlowCanvas에 먹였으나, 그 둘이
  // NextMakerScreen으로 교체되며 그 컴포넌트가 같은 엔드포인트를 자기 몫(막힘 합계)으로
  // 스스로 fetch한다 — 여기서 또 부르면 같은 요청을 두 번 쏘는 것이라 제거한다(§I-6 "두 벌
  // 서지 않는다"의 거울상 — 이번엔 fetch 중복 쪽).
  const fetchData = useCallback((cancelledRef: { cancelled: boolean }) => {
    setLoading(true);
    void (async () => {
      try {
        const result = await loadGlanceData(projectId);
        if (cancelledRef.cancelled) return;
        setData(result);
      } catch {
        if (cancelledRef.cancelled) return;
        setData(null);
      } finally {
        if (!cancelledRef.cancelled) setLoading(false);
      }
    })();
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const cancelledRef = { cancelled: false };
    fetchData(cancelledRef);
    return () => { cancelledRef.cancelled = true; };
  }, [projectId, fetchData]);

  const setView = useCallback((next: FlowView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'flow') params.delete('view');
    else params.set('view', next);
    const qs = params.toString();
    router.push(`/${wsSlug}/${projSlug}/flow${qs ? `?${qs}` : ''}`);
  }, [router, searchParams, wsSlug, projSlug]);

  // 선생님 지적(2026-07-30, 오르테가군 전달) — "노드를 눌러도 아무 일이 안 나는" 것이
  // #2224 AC1의 두 번째 결함이었다(간선 그리기와 별개). PO 판정: 「패널을 연다」로 간다
  // (캔버스 안 확장은 절대좌표라 레이아웃이 흔들리고, 곧 들어올 줌과도 정면충돌). 이미
  // `KanbanBoard`가 `?story=` 를 읽어 패널을 여는 길이 있다(딥링크가 그 길을 쓴다) —
  // 새 패널을 짓지 않고 «그 길을 그대로 타는» 것이 오늘의 배선. view를 list로 함께
  // 바꿔야 KanbanBoard 자체가 마운트된다(list일 때만 렌더되는 조건부 마운트, 아래 참고).
  const handleSelectStory = useCallback((storyId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'list');
    params.set('story', storyId);
    router.push(`/${wsSlug}/${projSlug}/flow?${params.toString()}`);
  }, [router, searchParams, wsSlug, projSlug]);

  const exceptionItems = useMemo(() => {
    if (!data) return [];
    const labels: ExceptionLabels = {
      kind: {
        gate_pending: tGlance('exceptionKindGatePending'),
        blocked: tGlance('exceptionKindBlocked'),
        merge_ready: tGlance('exceptionKindMergeReady'),
      },
      action: {
        gate_pending: tGlance('exceptionActionGatePending'),
        blocked: tGlance('exceptionActionBlocked'),
        merge_ready: tGlance('exceptionActionMergeReady'),
      },
    };
    return toExceptionQueueItems(data.attentionSignals as BeAttentionSignal[], labels);
  }, [data, tGlance]);

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />

      <div className="space-y-4 p-4">
        {/* ② 두 칸 세그(갈래|칸반) — 07-23 시안(`e15905e8`)에서 되찾음(IA 개정 때 조용히
            지워졌던 것, 유나 지적 2026-07-30). ⛔"현황판" 세 번째 칸은 선생님 재정정으로
            지웠다(짓지 않은 게 아니라 "안 짓기로" 확定해 없앤 것 — glance의 다섯 소스가 전부
            다른 자리로 흡수되어 열등한 세 번째 판이 필요 없어졌다). 모바일은 #2225의
            갈래·막힘·멈춤 탭이 이 자리를 대신하므로 세그를 그리지 않는다(isMobile===undefined인
            최초 렌더에서도 안전하게 숨김 — 하이드레이션 후 실값으로 켜진다). */}
        {isMobile ? null : (
          <div className="flex items-center gap-1 border-b border-border pb-2">
            <button
              type="button"
              onClick={() => setView('flow')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'flow' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t('viewFlow')}
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t('viewList')}
            </button>
          </div>
        )}

        {view === 'list' ? (
          // 2026-07-30 PO 확認 대기 — 07-23 시안의 「목록」이 칸반과 동일한지 디디군이 확認
          // 중(단순 표라면 드래그로 상태를 바꾸는 길이 사라지는지라 다르다). 답 오기 前엔
          // 되돌리기 쉬운 쪽(칸반 그대로 임베드)으로 가정한다 — kanban-board.tsx를 새로 그리지
          // 않고 그대로 마운트, `?view=kanban`(레거시)도 이 칸으로 들어온다.
          <KanbanBoard projectId={projectId} wsSlug={wsSlug} projSlug={projSlug} />
        ) : (
          // 「갈래」보기 — story #2224 후속(2026-07-31, PO 지시, 아티팩트 a920c25f v2 "다음을
          // 만드는 화면"). GlanceHero(①초점 스트립)+FlowLane(좌 레인)+FlowCanvas(에픽 아코디언)
          // 3종을 NextMakerScreen 하나로 교체한다 — 실측이 초점을 뒤집었다: 문제는 "다음이 안
          // 보이는 것"이 아니라 "다음이 없는 것"이라 첫 줄이 그 사실을 직접 말하고, 이어짐(선)은
          // 줄기를 펼쳤을 때만 보조로 붙는다(본체가 아니다 — PO note ⑤). memberMap은
          // loadGlanceData가 이미 fetch한 것(GlanceHero가 쓰던 그 재료, §I-6 재사용).
          loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t('loading')}
            </div>
          ) : (
            <NextMakerScreen projectId={projectId} memberMap={data?.memberMap ?? {}} onSelectStory={handleSelectStory} />
          )
        )}

        {/* ③ 관제 서랍 — 보기 무관 고정, 접힘 기본(IA §2). ExceptionStream = #2100 예외 스트림
            그대로 재사용(A타입, AC4 — glance-board.tsx가 쓰는 그 컴포넌트 그대로, 새로 그린
            코드 없음. 두 컴포넌트가 아니다). `<summary>`는 native하게 접힌 상태에서도 항상
            보이므로 카운트는 접어도 보인다(PO 판정 2026-07-30 — AC8이 접힌 채로도 반쯤 성립).
            ⚠️카운트 출처 — 지금은 `/api/glance/attention`의 gate_pending+blocked+merge_ready
            (WorkflowLineStepApproval/ItemDependency 기반)다. 이것은 민 실측 "검증 필요 32건"
            (Gate.requires_human+evidence_status=insufficient, PR#2672 blocked와 동일 정의로
            맞춤) 과 다른 쿼리라 다른 수를 낼 수 있다 — 그래서 라벨을 "검증 필요"로 부르지 않고
            "게이트·막힘 신호"로 남겨 둔다.
            ⛔만료 조건(PO 2026-07-30, 안 적으면 이 이름이 영구가 된다): PR#2672 착지 시 A로
            통일하고 · 이 자리의 B 라벨을 "검증 필요"로 되돌린다. 그때까지 좌 레인(flow-lane.tsx)
            의 blocked/stalled 칸도 "모름"으로 비워 두고, 막힘류 수는 이 관제 서랍 한 곳에서만
            보인다(같은 화면에 A·B 두 자가 동시에 서지 않게). */}
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-foreground">
            {t('drawerHeading', { n: exceptionItems.length })}
          </summary>
          <div className="border-t border-border p-3">
            <ExceptionStream items={exceptionItems} />
          </div>
        </details>
      </div>
    </>
  );
}
