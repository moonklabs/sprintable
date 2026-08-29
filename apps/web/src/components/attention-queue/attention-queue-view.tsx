'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck, ChevronRight } from 'lucide-react';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { formatRelativeTime } from '@/lib/storage/format';
import { cn } from '@/lib/utils';
import {
  parseAttentionQueueSignals, buildAttentionQueueFromBe,
  buildAttentionQueue, diffAttentionQueueItemIds,
  type AttentionQueueItem, type AttentionQueueTranslator,
} from './derive-attention-queue';

import { fetchWithAuth } from '@/lib/db/client';

const CAP = 7;
// 9ef0f914: story.trust_stage_changed 버스트(같은 story 연속 전이 등)를 단발 재조회로 병합.
const REFETCH_DEBOUNCE_MS = 500;
// 신규/갱신 행 1회 하이라이트 지속(트랜지션 700ms보다 살짝 길게 — transition-colors 완주 보장).
const HIGHLIGHT_MS = 900;

/** story #1969(2026-08-30) — inbox_items(외부 producer, /api/inbox) 기반 흡수(#2923)는 PO
 * 최종 판정으로 inbox_items 기능 자체가 완전 은퇴되며 함께 걷혔다. 이제 `/glance/attention`
 * BE 신호 하나만 소비한다(gate_pending dedup·memo slug 해소 등 inbox 전용 로직도 전부 제거). */
async function fetchAttentionQueue(projectId: string, t: AttentionQueueTranslator): Promise<AttentionQueueItem[]> {
  const beJson = await fetchWithAuth(`/api/glance/attention?project_id=${projectId}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const signals = parseAttentionQueueSignals(beJson);
  return buildAttentionQueueFromBe(signals, t);
}

function RowSkeleton() {
  return <div className="h-[52px] animate-pulse border-b border-proof-line-soft bg-proof-sunk/60 last:border-b-0" />;
}

// story #3052(2984-S4) — 헤어라인 액센트(회귀가드) 단위 테스트를 위해 export(전체 폴링
// 생명주기를 시뮬레이션하지 않고 highlighted prop만 직접 검증).
export function AttentionRow({ item, highlighted, onNavigate }: {
  item: AttentionQueueItem; highlighted: boolean; onNavigate: (href: string) => void;
}) {
  // AttentionQueueItem.href는 string | null(방어적 계약) — href가 없으면 행을 비내비게이션
  // 처리한다(role/tabIndex/onClick/버튼 전부 생략, 정적 표시만. 있지도 않은 라우트를 지어내지
  // 않는다는 원칙).
  const navigable = item.href !== null;
  return (
    <div
      role={navigable ? 'button' : undefined}
      tabIndex={navigable ? 0 : undefined}
      onClick={navigable ? (e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onNavigate(item.href!);
      } : undefined}
      onKeyDown={navigable ? (e) => {
        if (e.key === 'Enter') onNavigate(item.href!);
      } : undefined}
      className={cn(
        'border-b border-b-proof-line-soft border-l-2 border-l-transparent last:border-b-0',
        navigable && 'cursor-pointer hover:bg-proof-sunk',
        'motion-safe:transition-colors motion-safe:duration-700',
        // story #3052(2984-S4) — "최근 변경" 신호는 fill(citron/15 배경 wash) 대신 헤어라인
        // 액센트(좌측 테두리)로. 색 신호 자체는 KEEP(citron 유지) — fill만 제거.
        highlighted && 'motion-safe:border-l-proof-citron',
      )}
    >
      <ProofCapsule
        density="row"
        proofState={item.proofState}
        stateLabel={item.kindLabel}
        typeBadge={item.bucket}
        claim={item.claim}
        human={item.actor && !item.actor.isAgent ? { name: item.actor.name, role: '' } : undefined}
        agent={item.actor?.isAgent ? { name: item.actor.name, initial: item.actor.name.slice(0, 1) } : undefined}
        gate={navigable ? { action: item.actionLabel, href: item.href!, tone: item.actionTone } : undefined}
        duration={item.enteredStateAtMs !== null ? formatRelativeTime(new Date(item.enteredStateAtMs).toISOString()) : undefined}
        className="rounded-none border-0"
      />
    </div>
  );
}

/**
 * Attention Queue(E-UI-DAEGBYEON P0-05, story 7ff12083, 설계 5f25c615). "지금 개입할 3~7개"만 —
 * 원시 이벤트 나열 아니라 판단이 필요한 것만. Proof Capsule row density 재사용(신규 컴포넌트 아님).
 * 배치 = `/inbox?tab=attention`(지금/Now 존·기존 인박스 병행 — PO 확定 2026-07-13).
 *
 * 2단계(BE 계약 스왑) 완료: 데이터 소스 = `/glance/attention`(P0-04 trust 파이프라인 파생, doc
 * trust-pipeline-be-design §6). 4유형(검증실패/결정필요[needs_input+gate_pending 합류]/막힘/
 * 병합대기) — 범위이탈(Red)은 BE가 §7 확定②로 여전히 미구현이라 항상 빈 신호(no-fiction 렌더
 * 생략). actor(human/agent 아바타)는 BE `AttentionItem`에 assignee 필드가 없어 당분간 없음
 * (P0-03 `human_owner_member_id` 노출 시 복원 예정 — 별도 low 스토리).
 *
 * story #2923(P0-E AQ1, doc attention-audit-redesign-2923)이 별도 패널이던 DecisionsWaiting
 * (`/api/inbox?state=pending`, inbox_items 기반)을 이 뷰로 흡수했으나(패널 폐기,
 * decisions-waiting.tsx 삭제), story #1969(2026-08-30, PO 최종 판정)로 inbox_items 기능 자체가
 * 완전 은퇴되며 그 흡수 로직도 함께 걷혔다 — 지금은 `/glance/attention` 단일 BE 소스만 소비.
 * 각 항목엔 `bucket`(GATE/STEER/BLOCK/Q, PO 9→4 매핑표)이 붙는데, 이 슬라이스는 데이터 계층만
 * — 실제 배지 렌더는 AQ2가 한다.
 *
 * SSE 실시간 반영(9ef0f914, P0-04 "새로고침 없이" 완료기준의 잔여): `story.trust_stage_changed`
 * 수신을 **트리거로만** 쓴다 — payload의 exception_signals는 이 story 하나의 불리언일 뿐(gate_pending
 * 미포함)이라 클라에서 신뢰의 소스로 쓰면 결정필요 행이 유령으로 남거나 거짓 ALL CLEAR가 재발한다
 * (PO 콜 2026-07-13). 대신 이벤트 수신 시 `/glance/attention`을 디바운스 단발 재조회(진실은 항상
 * 서버) — 4중 fan-out이던 v1 클라 파생과 달리 단일 저비용 호출이라 "전량 리페치 금지" 취지 위반
 * 아님. 이전 리스트와 diff해 신규/갱신 행만 1회 하이라이트(全행 반짝 금지·prefers-reduced-motion).
 */
export function AttentionQueueView({ projectId, memberId }: { projectId: string; memberId?: string }) {
  const router = useRouter();
  const t = useTranslations('attentionQueue');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<AttentionQueueItem[]>([]);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const refetchAndDiff = useCallback(async () => {
    const result = await fetchAttentionQueue(projectId, t);
    const changed = diffAttentionQueueItemIds(itemsRef.current, result);
    setItems(result);
    if (changed.size > 0) {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedIds(changed);
      highlightTimerRef.current = setTimeout(() => setHighlightedIds(new Set()), HIGHLIGHT_MS);
    }
  }, [projectId, t]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const result = await fetchAttentionQueue(projectId, t);
      if (cancelled) return;
      setItems(result);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [projectId, t]);

  const handleTrustStageChanged = useCallback((_eventName: string, data: unknown) => {
    if (typeof data !== 'object' || data === null) return;
    // project 스코프 필터 — SSE는 org 단위 스트림이라 이 AQ가 보는 프로젝트 밖 story 전이는 무시.
    if ((data as Record<string, unknown>)['project_id'] !== projectId) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void refetchAndDiff();
    }, REFETCH_DEBOUNCE_MS);
  }, [projectId, refetchAndDiff]);

  useSseNotifications({
    memberId,
    extraEventNames: ['story.trust_stage_changed'],
    onExtraEvent: handleTrustStageChanged,
  });

  const { shown, overflow, overflowHasGate } = buildAttentionQueue(items, CAP);

  return (
    // story #7d7634ee(P0·선생님 직접 지시) — 컷코너(clip-path) 폐지, proof-surface(13px 균일
    // 라운드)+proof-surface-lift(뜬 표면 재질) 채택. 옛 rounded-2xl은 proof-surface의
    // --proof-radius-soft로 흡수(중복 라운드 선언 제거).
    <div className="proof-surface proof-surface-lift overflow-hidden border border-proof-line bg-proof-panel">
      <div className="flex items-baseline justify-between gap-3 border-b border-proof-line-soft px-5 py-3.5">
        {/* story #3010(로드맵 P3, L5 대비) — text-proof-faint 라이트 대비 미달(story #2993
            유나 처방과 동일 클래스) → text-proof-ink-3(아래 kicker·empty body 2곳). */}
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-proof-ink-3">{t('kicker')}</div>
          {/* story #3010(로드맵 P3, L6, 유나 판정 2026-08-24) — 이 h2는 반복 그룹 라벨이 아니라
              섹션 주 제목(단일 마운트)이라 L6 대상. weight만 font-editorial-heading(820)로
              교체, 19px 크기는 유지. */}
          <h2 className="text-[19px] font-editorial-heading leading-tight tracking-[-0.014em] text-proof-ink">{t('title')}</h2>
        </div>
        {!loading ? (
          <div className="shrink-0 text-[13px] font-medium text-proof-ink-3">
            {t.rich('count', { count: shown.length, b: (chunks) => <b className="text-proof-ink">{chunks}</b> })}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div>{Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          {/* story #3099(DS·AA 후속) — green 소형텍스트(11px bold) AA 미달, 텍스트는 중립화
              (text-proof-ink)하고 색 신호는 아이콘 하나로 좁힌다(#3090과 동형: 색은 그래픽,
              텍스트는 중립 — 아이콘은 3:1 non-text 기준으로 이미 PASS). */}
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.02em] text-proof-ink">
            <ShieldCheck className="size-3.5 text-proof-green" aria-hidden="true" />{t('allClear')}
          </div>
          <p className="text-[15px] font-semibold text-proof-ink-2">{t('emptyTitle')}</p>
          <p className="text-[12.5px] text-proof-ink-3">{t('emptyBody')}</p>
        </div>
      ) : (
        <div>
          {shown.map((item) => (
            <AttentionRow
              key={item.id} item={item} highlighted={highlightedIds.has(item.id)}
              onNavigate={(href) => router.push(href)}
            />
          ))}
          {/* story #2923(P0-E AQ3, doc attention-audit-redesign-2923) — 「결재함=완전 목록
              overflow·Attention GATE 앵커」. 상한(cap) 초과분이 사라지지 않고 결재함(현 gates
              탭, ApprovalsQueue=Gate 3종 완전 목록)에 그대로 있다는 걸 클릭 가능한 앵커로
              보여준다(예전엔 순수 텍스트, 갈 곳이 없었다).
              MEDIUM①(카디르 QA, PR#3353 2026-08-22) — overflow가 GATE 버킷 0건일 수도
              있는데(잘린 게 전부 STEER/BLOCK/Q라면) 그때 gates 탭 앵커를 걸면 눌러도 결재함에
              그 항목이 없다(재현: needs_input 10건→overflow 3, 전부 STEER라 GATE 0). bucket
              필드(AQ1)로 정밀 판정 — GATE가 1개라도 잘려나갔을 때만 앵커, 0건이면 기존
              비내비게이션 텍스트로 정직하게 폴백(「거기 전부 있다」로 과장 안 함). 착지 탭
              기본값 변경(B3 보류)은 스코프 밖(PO 확定) — 이 앵커는 명시적 tab=gates 링크일
              뿐 기본 착지를 바꾸지 않는다. */}
          {overflow > 0 && overflowHasGate ? (
            <button
              type="button"
              onClick={() => router.push('/inbox?tab=gates')}
              className="flex w-full items-center gap-1.5 border-t border-proof-line-soft bg-proof-sunk px-5 py-2.5 text-left text-[12.5px] text-proof-ink-3 transition-colors hover:bg-proof-line-soft hover:text-proof-ink-2"
            >
              <span className="size-1 rounded-full bg-proof-faint" aria-hidden="true" />
              <span className="flex-1">{t('flowDemoted', { overflow })}</span>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : overflow > 0 ? (
            <div className="flex items-center gap-1.5 border-t border-proof-line-soft bg-proof-sunk px-5 py-2.5 text-[12.5px] text-proof-ink-3">
              <span className="size-1 rounded-full bg-proof-faint" aria-hidden="true" />
              {t('flowDemoted', { overflow })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
