'use client';

import { useTranslations } from 'next-intl';
import type { FlowLaneRow } from './derive-flow';
import { derivePastRatio, deriveEdgeSummary } from './derive-flow';

interface FlowCanvasProps {
  rows: FlowLaneRow[];
  /** 활성(active) 에픽 id — 있으면 "지금" 표식을 그 행에 그린다(focus strip의 heroStory와
   * 같은 에픽 — 중복 카드 없이 위치만 가리킨다, §I-6). */
  activeEpicId: string | null;
  /** 간선(구조화된 연결) 개수. #2221(BE) 미착지라 오늘은 항상 0 — 그러나 이 값은 실제
   * 배열 길이에서 온 것이라 #2221 착지 즉시 자동으로 갱신된다(하드코딩 금지, PO 2026-07-30). */
  edgeCount: number;
}

/**
 * story #2224 — 갈래 캔버스 MVP. 개별 스토리 단위 노드는 아직 안 그린다: load-glance-data.ts가
 * story #2298(3단 웨이터폴 근절)에서 `roadmap.map(epic => /api/stories?epic_id=)` N+1 fetch를
 * 의도적으로 제거했고, 그 결정을 이 화면에서 다시 들여오면 회귀다. 그래서 "지나온 것 | 지금 |
 * 이어질 것"은 에픽 단위로 done/total 비율만 정직하게 그린다 — 실제 데이터(EpicProgress)가
 * 감당하는 정밀도가 여기까지다.
 */
export function FlowCanvas({ rows, activeEpicId, edgeCount }: FlowCanvasProps) {
  const t = useTranslations('flow');
  const edges = deriveEdgeSummary(edgeCount);

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
      {/* 유나 규격 — 미수집·미구현·안 그림을 갈라 보이지 않고 "아직 표시하지 않습니다" 한 줄에
          항목만 합쳐 나열한다(좌 레인의 진행/대기/막힘/멈춤 결핍도 여기 한 곳에 합침, flow-lane.tsx
          참조). 만료 조건은 화면이 아니라 #2224 본문에 둔다(PO가 직접 기입).
          ⚠️민의 #2338 교훈 재확認(2026-07-30) — 이 문구는 지금 "그릴 데이터 소스 자체가 없다"는
          무조건 참인 사실을 말하는 것이라 하드코딩이 안전하다(#2338의 `isPending()`처럼 "데이터가
          와도 영원히 안 빠지는 조건"이 아니다). PR#2672(좌 레인 4분류) 데이터를 실제로 fetch해
          붙이는 후속 커밋에서는, 그 fetch 결과의 null/undefined 여부로 이 목록에서 항목을 빼는
          조건을 반드시 써야 한다 — 지금처럼 무조건 보여주는 문자열로 두면 재료가 와도 안 빠지는
          같은 함정에 빠진다. */}
      <p className="px-3 text-[11px] text-muted-foreground/70">{t('canvasNotYetShown')}</p>

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
            return (
              <li key={row.id} className="space-y-1">
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
