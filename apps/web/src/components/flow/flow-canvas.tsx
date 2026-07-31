'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FlowLaneRow } from './derive-flow';
import { derivePastRatio, deriveEdgeSummary } from './derive-flow';
import { FlowEpicNodes } from './flow-epic-nodes';

interface FlowCanvasProps {
  rows: FlowLaneRow[];
  /** 활성(active) 에픽 id — 있으면 "지금" 표식을 그 행에 그린다(focus strip의 heroStory와
   * 같은 에픽 — 중복 카드 없이 위치만 가리킨다, §I-6). */
  activeEpicId: string | null;
  /** 간선(구조화된 연결) 개수. #2221(BE) 미착지라 오늘은 항상 0 — 그러나 이 값은 실제
   * 배열 길이에서 온 것이라 #2221 착지 즉시 자동으로 갱신된다(하드코딩 금지, PO 2026-07-30). */
  edgeCount: number;
  /** 노드 틀(2026-07-30) — 펼친 에픽의 스토리 노드를 부르는 데 필요. */
  projectId: string;
  /** 노드 클릭 → 스토리 상세 패널 열기(선생님 지적 2026-07-30 — "노드를 눌러도 아무 일이
   * 안 나는" AC1 결함 후속). PO 판정: `?view=list&story={id}`로 네비게이트(KanbanBoard의
   * 기존 패널 오픈 경로를 그대로 탄다). */
  onSelectStory: (storyId: string) => void;
}

/**
 * story #2224 — 갈래 캔버스 MVP. 기본은 에픽 단위 done/total 비율 막대만 그린다(§2298이
 * 없앤 `roadmap.map(epic => /api/stories?epic_id=)` N+1을 항상 켜 두면 회귀이므로). 개별
 * 스토리 노드는 2026-07-30 후속(선생님 지적 — "다음 판이 다음 에픽?") 판정에 따라 행을
 * 펼쳤을 때만 `?epic_id=` 단위 온디맨드로 부른다(FlowEpicNodes) — 179개 전체를 한 번에
 * 부르지 않으므로 N+1 회귀가 아니다(펼친 «하나»만, PO 판정 명시).
 */
export function FlowCanvas({ rows, activeEpicId, edgeCount, projectId, onSelectStory }: FlowCanvasProps) {
  const t = useTranslations('flow');
  const edges = deriveEdgeSummary(edgeCount);
  // 접힌 상태 기본(PO 판정 2026-07-30) — 단일 아코디언(동시 여러 에픽 펼침 방지, 온디맨드
  // fetch가 동시에 여러 건 나가는 것을 구조로 막는다).
  const [expandedEpicId, setExpandedEpicId] = useState<string | null>(null);

  return (
    <div className="min-w-0 flex-1 space-y-4">
      {/* PO 판정(2026-07-30) — 막대만 있는데 화면 이름이 "갈래"면 "이게 다인가"로 읽힌다.
          "없는 것"과 "아직 안 그린 것"은 다르고, 후자는 사람에게 곧 온다는 것을 알려야 한다
          (#2224 AC "모르는 것을 모른다고 말한다"의 이 자리 판). 왜(#2298이 없앤 roadmap.map(epic
          => /api/stories?epic_id=) N+1을 다시 들이는 구조라 이번 판에서 개별 노드·시간축을 안
          그림)는 여기 코드 주석에만 두고 화면 문구에는 안 싣는다(유나 규격 2026-07-30 — "사용자가
          이 차이로 무엇을 다르게 하는가" 기준에서 "왜"는 우리 사정이라 화면에 흩뿌리지 않는다.
          괄호로 작게 붙여도 "갈라 보이는" 것은 같다 — 크기가 아니라 존재가 문제). */}
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
        {t('canvasScopeNotice')}
      </p>
      {/* canvasNotYetShown(진행/대기/막힘/멈춤 결핍 고지) 제거(2026-07-30) — 그 4항목을
          좌 레인이 실제로 그리기 시작해(#2672 배선, flow-lane.tsx) 더 이상 참이 아닌 문구가
          됐다(#2338 교훈 그대로 — 데이터가 오면 반드시 빼야 하는 자리). 지금 이 캔버스가 정말
          안 그리는 것(문·간선·연결 포트·드래그)은 canvasScopeNotice 한 줄로 충분하다. */}

      <div className="grid grid-cols-3 gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <span>{t('canvasPast')}</span>
        <span className="text-center text-info">{t('canvasNow')}</span>
        <span className="text-right">{t('canvasUpcoming')}</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-1 py-6 text-xs text-muted-foreground">{t('canvasEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const pastRatio = derivePastRatio(row.done, row.total);
            const isActive = row.id === activeEpicId;
            const isExpanded = row.id === expandedEpicId;
            return (
              <li key={row.id} className="space-y-1">
                <button
                  type="button"
                  className="w-full space-y-1 text-left focus-inset"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedEpicId(isExpanded ? null : row.id)}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="min-w-0 truncate text-foreground">{row.title}</span>
                    {isActive ? (
                      <span className="shrink-0 rounded border border-info/40 px-1.5 py-0.5 text-[10px] font-medium text-info">
                        {t('canvasActiveMarker')}
                      </span>
                    ) : null}
                  </div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-foreground/30" style={{ width: `${pastRatio}%` }} />
                    {isActive ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-0 h-full w-0.5 bg-info"
                        style={{ left: `${pastRatio}%` }}
                      />
                    ) : null}
                  </div>
                </button>
                {isExpanded ? <FlowEpicNodes projectId={projectId} epicId={row.id} epicTitle={row.title} onSelectStory={onSelectStory} memberMap={{}} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-border pt-2 text-[11px] text-muted-foreground">
        {edges.isEmpty ? t('edgesEmptyHonest') : t('edgesCount', { n: edges.count })}
      </div>
    </div>
  );
}
