'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { cn } from '@/lib/utils';
import {
  parseAttentionQueueSignals, buildAttentionQueueFromBe, buildAttentionQueue, diffAttentionQueueItemIds,
  type AttentionQueueItem, type AttentionQueueTranslator,
} from './derive-attention-queue';

const CAP = 7;
// 9ef0f914: story.trust_stage_changed 버스트(같은 story 연속 전이 등)를 단발 재조회로 병합.
const REFETCH_DEBOUNCE_MS = 500;
// 신규/갱신 행 1회 하이라이트 지속(트랜지션 700ms보다 살짝 길게 — transition-colors 완주 보장).
const HIGHLIGHT_MS = 900;

async function fetchAttentionQueue(projectId: string, t: AttentionQueueTranslator): Promise<AttentionQueueItem[]> {
  const json = await fetch(`/api/glance/attention?project_id=${projectId}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const signals = parseAttentionQueueSignals(json);
  return buildAttentionQueueFromBe(signals, t);
}

function RowSkeleton() {
  return <div className="h-[52px] animate-pulse border-b border-proof-line-soft bg-proof-sunk/60 last:border-b-0" />;
}

function AttentionRow({ item, highlighted, onNavigate }: {
  item: AttentionQueueItem; highlighted: boolean; onNavigate: (href: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onNavigate(item.href);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onNavigate(item.href);
      }}
      className={cn(
        'cursor-pointer border-b border-proof-line-soft last:border-b-0 hover:bg-proof-sunk',
        'motion-safe:transition-colors motion-safe:duration-700',
        highlighted && 'motion-safe:bg-proof-citron/15',
      )}
    >
      <ProofCapsule
        density="row"
        proofState={item.proofState}
        stateLabel={item.kindLabel}
        claim={item.claim}
        human={item.actor && !item.actor.isAgent ? { name: item.actor.name, role: '' } : undefined}
        agent={item.actor?.isAgent ? { name: item.actor.name, initial: item.actor.name.slice(0, 1) } : undefined}
        gate={{ action: item.actionLabel, href: item.href, tone: item.actionTone }}
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

  const { shown, overflow } = buildAttentionQueue(items, CAP);

  return (
    <div className="overflow-hidden rounded-2xl border border-proof-line bg-proof-panel" style={{ clipPath: 'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)' }}>
      <div className="flex items-baseline justify-between gap-3 border-b border-proof-line-soft px-5 py-3.5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-proof-faint">{t('kicker')}</div>
          <h2 className="text-[19px] font-extrabold leading-tight tracking-[-0.014em] text-proof-ink">{t('title')}</h2>
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
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.02em] text-proof-green">
            <ShieldCheck className="size-3.5" aria-hidden="true" />{t('allClear')}
          </div>
          <p className="text-[15px] font-semibold text-proof-ink-2">{t('emptyTitle')}</p>
          <p className="text-[12.5px] text-proof-faint">{t('emptyBody')}</p>
        </div>
      ) : (
        <div>
          {shown.map((item) => (
            <AttentionRow
              key={item.id} item={item} highlighted={highlightedIds.has(item.id)}
              onNavigate={(href) => router.push(href)}
            />
          ))}
          {overflow > 0 ? (
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
