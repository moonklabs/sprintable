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
  parseAttentionQueueSignals, buildAttentionQueueFromBe, parseInboxAttentionItems, buildAttentionQueueFromInbox,
  dedupInboxApprovalsAgainstGatePending, buildAttentionQueue, diffAttentionQueueItemIds,
  type AttentionQueueItem, type AttentionQueueTranslator, type InboxAttentionItem,
} from './derive-attention-queue';

import { fetchWithAuth } from '@/lib/db/client';

const CAP = 7;
// 9ef0f914: story.trust_stage_changed 버스트(같은 story 연속 전이 등)를 단발 재조회로 병합.
const REFETCH_DEBOUNCE_MS = 500;
// 신규/갱신 행 1회 하이라이트 지속(트랜지션 700ms보다 살짝 길게 — transition-colors 완주 보장).
const HIGHLIGHT_MS = 900;

/** story #2923 AQ1 — inbox 항목 중 origin_chain에 story가 없고 memo만 있는 것들의 doc id→slug
 * 를 배치 해소한다(`/api/docs/{id}/summary`, loop-detail-client.tsx 선례와 동형 — id→slug
 * 전용 lightweight 엔드포인트, 신규 API 없음). 병렬 fetch — inbox 항목은 3~7개 티어라 N+1이
 * 문제될 규모가 아니다. 실패한 건은 조용히 맵에서 빠져(resolveInboxItemHref가 그 경우 그대로
 * null로 정직 처리) 페이지 전체가 안 죽는다. */
async function resolveMemoSlugs(items: InboxAttentionItem[]): Promise<Map<string, string>> {
  const memoIds = new Set<string>();
  for (const item of items) {
    const hasStory = item.origin_chain.some((n) => n.type === 'story');
    if (hasStory) continue; // story 우선순위가 이기므로 memo 해소가 아예 불필요
    for (const node of item.origin_chain) {
      if (node.type === 'memo') memoIds.add(node.id);
    }
  }
  const entries = await Promise.all(
    [...memoIds].map(async (id) => {
      const json = await fetchWithAuth(`/api/docs/${id}/summary`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const slug = json?.data?.slug;
      return typeof slug === 'string' && slug ? ([id, slug] as const) : null;
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, string] => e !== null));
}

async function fetchAttentionQueue(projectId: string, t: AttentionQueueTranslator): Promise<AttentionQueueItem[]> {
  // 카디르 QA HIGH1(PR#3352, 2026-08-22) — project_id 파라미터 부재로 다른 프로젝트의 inbox
  // 항목까지 섞여 나왔다. 위 BE attention fetch와 동형으로 project_id를 싣는다(BE도 필수
  // 쿼리 파라미터로 처방 완료 — backend/app/routers/notifications.py list_inbox).
  const [beJson, inboxJson] = await Promise.all([
    fetchWithAuth(`/api/glance/attention?project_id=${projectId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchWithAuth(`/api/inbox?state=pending&project_id=${projectId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const signals = parseAttentionQueueSignals(beJson);
  const beItems = buildAttentionQueueFromBe(signals, t);
  // 카디르 QA HIGH2(PR#3352, 2026-08-22) — gate_pending(Gate 1차 소스)과 approval(inbox_items)
  // 이 같은 story에 동시 존재하면 같은 사실이 두 행으로 중복 노출된다. gate_pending 원신호의
  // story_id 집합을 뽑아 inbox approval 쪽에서 겹치는 것만 drop(Gate가 1차 소스 우선).
  const gatePendingStoryIds = new Set(
    signals.filter((s) => s.kind === 'gate_pending' && s.story_id).map((s) => s.story_id!),
  );
  const inboxItems = dedupInboxApprovalsAgainstGatePending(parseInboxAttentionItems(inboxJson), gatePendingStoryIds);
  const docSlugById = await resolveMemoSlugs(inboxItems);
  return [...beItems, ...buildAttentionQueueFromInbox(inboxItems, t, docSlugById)];
}

function RowSkeleton() {
  return <div className="h-[52px] animate-pulse border-b border-proof-line-soft bg-proof-sunk/60 last:border-b-0" />;
}

// story #3052(2984-S4) — 헤어라인 액센트(회귀가드) 단위 테스트를 위해 export(전체 폴링
// 생명주기를 시뮬레이션하지 않고 highlighted prop만 직접 검증).
export function AttentionRow({ item, highlighted, onNavigate }: {
  item: AttentionQueueItem; highlighted: boolean; onNavigate: (href: string) => void;
}) {
  // story #2923 AQ1(PO 실측, 2026-08-22) — inbox 병합 항목 중 origin_chain이 story/memo 어느
  // 쪽도 없으면(run/initiative만) href가 null이다(상세 라우트 자체가 FE에 없다, 지어내지
  // 않음) — 그 경우 행을 비내비게이션 처리(role/tabIndex/onClick/버튼 전부 생략, 정적 표시만).
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
 * story #2923(P0-E AQ1, doc attention-audit-redesign-2923) — 별도 패널이던 DecisionsWaiting
 * (`/api/inbox?state=pending`)을 이 뷰로 흡수(패널 폐기, decisions-waiting.tsx 삭제). 두 BE
 * 소스를 병렬 fetch 후 병합(derive-attention-queue.ts의 buildAttentionQueueFromBe/FromInbox)
 * — 다건 옵션 resolve/reassign/dismiss는 PO 확定(단순화)으로 row에 안 옮기고 상세 화면 몫으로
 * 남긴다. 각 항목엔 이제 `bucket`(GATE/STEER/BLOCK/Q, PO 9→4 매핑표)이 붙는데, 이 슬라이스는
 * 데이터 계층만 — 실제 배지 렌더는 AQ2가 한다(아직 시각 변화 없음).
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
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.02em] text-proof-green">
            <ShieldCheck className="size-3.5" aria-hidden="true" />{t('allClear')}
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
