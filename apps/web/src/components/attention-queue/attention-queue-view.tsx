'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ShieldCheck, ChevronRight } from 'lucide-react';
import type { ProofState } from '@/components/proof-capsule/proofline';
import { Avatar } from '@/components/shared/avatar';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { cn } from '@/lib/utils';
import {
  parseAttentionQueueSignals, parseAttentionTruncatedKinds, buildAttentionQueueFromBe,
  buildAttentionQueue, diffAttentionQueueItemIds,
  type AttentionQueueItem, type AttentionQueueTranslator,
} from './derive-attention-queue';
import { withProjectParam } from '@/lib/with-project-param';

import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

const CAP = 7;
// 9ef0f914: story.trust_stage_changed 버스트(같은 story 연속 전이 등)를 단발 재조회로 병합.
const REFETCH_DEBOUNCE_MS = 500;
// 신규/갱신 행 1회 하이라이트 지속(트랜지션 700ms보다 살짝 길게 — transition-colors 완주 보장).
const HIGHLIGHT_MS = 900;

/** story #1969(2026-08-30) — inbox_items(외부 producer, /api/inbox) 기반 흡수(#2923)는 PO
 * 최종 판정으로 inbox_items 기능 자체가 완전 은퇴되며 함께 걷혔다. 이제 `/glance/attention`
 * BE 신호 하나만 소비한다(gate_pending dedup·memo slug 해소 등 inbox 전용 로직도 전부 제거). */
async function fetchAttentionQueue(
  projectId: string, t: AttentionQueueTranslator,
): Promise<{ items: AttentionQueueItem[]; truncatedKinds: string[]; failed: boolean }> {
  // 4909 (가) — 읽기 실패(네트워크 예외 · 비정상 응답 · JSON 아님)는 «빈 목록»이 아니다. 예전엔 셋 다 null로 뭉개져
  // «안전 · 지금 개입할 것 없음»으로 보였다 — 실패는 따로 알려 화면이 «안전»이라 말하지 않게 한다.
  let beJson: unknown = null;
  let failed = false;
  try {
    const r = await fetchWithAuth(`/api/glance/attention?project_id=${projectId}`);
    if (r.ok) beJson = await r.json(); else failed = true;
  } catch { failed = true; }
  const signals = parseAttentionQueueSignals(beJson);
  return {
    items: buildAttentionQueueFromBe(signals, t, (href) => withProjectParam(href, projectId)),
    // story #4382 — BE가 한 신호를 100건에서 잘랐으면 남은 수는 «이상»으로만 말한다.
    truncatedKinds: parseAttentionTruncatedKinds(beJson),
    failed,
  };
}

function RowSkeleton() {
  return <div className="h-14 animate-pulse border-b border-ds-line bg-ds-surface-high/60 last:border-b-0" />;
}

// 4909 (AC3 3단계) — the row's state colour (the proof state) is a ds chip: the word stays (색만으로 뜻을 싣지 않는다), the tone carries the meaning.
const STATE_TONE: Record<ProofState, 'failed' | 'needs-hand' | 'done' | 'info'> = { red: 'failed', amber: 'needs-hand', green: 'done', blue: 'info' };
// the verb at the row's end («검토» …) keeps its old tone as the text's colour — it is the row's own words now, never a second button
const ACTION_TONE: Record<AttentionQueueItem['actionTone'], string> = { primary: 'font-semibold text-ds-action-text', neutral: 'text-ds-ink-2', ready: 'text-ds-done' };

// story #3052(2984-S4) — 헤어라인 액센트(회귀가드) 단위 테스트를 위해 export(전체 폴링
// 생명주기를 시뮬레이션하지 않고 highlighted prop만 직접 검증).
/**
 * One «지금 개입할 것» row (4909 AC3 3단계): a ds ListRow — state chip · the claim on one line · the mono second line «종류 · 시간» · the verb at the end. The whole row IS the link (a real `<a href>`, stretched over the row), so the
 * browser's own «open in a new tab» · ⌘-click come with it — the old separate gate button went to the same place as the row, so it is gone (one place, not two). A plain click goes through the app's router (as the row always did);
 * a click with a modifier key (or a middle click) is left to the browser. Without an `href` the row is static (no link, no role — never an invented route).
 */
export function AttentionRow({ item, highlighted, onNavigate }: {
  item: AttentionQueueItem; highlighted: boolean; onNavigate: (href: string) => void;
}) {
  const navigable = item.href !== null;
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const when = item.enteredStateAtMs !== null ? formatViewerRelativeTime(new Date(item.enteredStateAtMs).toISOString(), locale, displayTimezone) : null;
  const actor = item.actor ? <Avatar name={item.actor.name} actorType={item.actor.isAgent ? 'agent' : 'human'} size={22} /> : null;
  const claim = (
    navigable ? (
      <a
        href={item.href!}
        title={item.claim}
        data-row-focus
        className="outline-none after:absolute after:inset-0 after:content-['']"
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // the browser's own way (new tab · window · download) stays
          e.preventDefault();
          onNavigate(item.href!);
        }}
      >
        {item.claim}
      </a>
    ) : <span title={item.claim}>{item.claim}</span>
  );
  return (
    <ListRow
      data-testid="attention-row"
      leading={<Chip tone={STATE_TONE[item.proofState]} dot>{item.kindLabel}</Chip>}
      title={claim}
      subtitle={[item.bucket, when].filter(Boolean).join(' · ')}
      trailing={actor || navigable ? (
        <>
          {actor}
          {navigable ? (
            <span className={cn('inline-flex items-center gap-0.5 text-ds-small', ACTION_TONE[item.actionTone])}>{item.actionLabel}<ChevronRight className="size-3.5" aria-hidden="true" /></span>
          ) : null}
        </>
      ) : undefined}
      className={cn(
        'border-l-2 border-l-transparent last:border-b-0 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-ds-action',
        'motion-safe:transition-colors motion-safe:duration-700',
        // story #3052(2984-S4) — "최근 변경" 신호는 fill(배경 wash) 대신 왼쪽 막대로(질감 없음). 색 신호 자체는 KEEP.
        highlighted && 'motion-safe:border-l-ds-action',
      )}
    />
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
export function AttentionQueueView({ projectId }: { projectId: string }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const router = useRouter();
  const t = useTranslations('attentionQueue');
  const tCage = useTranslations('cage');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<AttentionQueueItem[]>([]);
  const [truncatedKinds, setTruncatedKinds] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 4909 (가) · codex 1라운드 — 읽기가 겹칠 때(처음 읽기 + SSE 재조회) 오래된 응답이 나중에 도착해 새 실패 표시를 지우고
  // «안전»을 그리면 안 된다. 요청마다 번호를 달고 가장 최근 번호의 응답만 화면에 반영한다.
  const requestSeqRef = useRef(0);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const refetchAndDiff = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const { items: result, truncatedKinds: nextTruncatedKinds, failed } = await fetchAttentionQueue(projectId, t);
    if (seq !== requestSeqRef.current) return;
    // 읽기에 실패하면 지금 보이는 목록을 비우지 않는다(비우면 «안전»으로 보임) — 실패만 표시한다.
    if (failed) { setLoadFailed(true); setLoading(false); return; }
    setLoadFailed(false);
    setLoading(false);
    const changed = diffAttentionQueueItemIds(itemsRef.current, result);
    setItems(result);
    setTruncatedKinds(nextTruncatedKinds);
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
      const seq = ++requestSeqRef.current;
      const { items: result, truncatedKinds: nextTruncatedKinds, failed } = await fetchAttentionQueue(projectId, t);
      if (cancelled || seq !== requestSeqRef.current) return;
      setItems(result);
      setTruncatedKinds(nextTruncatedKinds);
      setLoadFailed(failed);
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
    extraEventNames: ['story.trust_stage_changed'],
    onExtraEvent: handleTrustStageChanged,
  });

  const { shown, overflow, overflowHasGate } = buildAttentionQueue(items, CAP);
  const retryButton = (
    <Button type="button" size="md" variant="secondary" onClick={() => { void refetchAndDiff(); }}>
      {t('loadRetry')}
    </Button>
  );
  // story #4382(유나 CHANGES) — 넘침 줄 «{수} — {자리}». 숨은 행도 보이는 것과 같은 예외라 «흐르는 중»이 아니다. 자리: 숨은 행에 게이트가 있으면
  // 결재함(단추), 아니면 «처리되는 대로 여기 차례로». BE가 gate_pending을 잘랐으면 넘침이 0이어도 숨은 게이트가 있다.
  const truncated = truncatedKinds.length > 0;
  const hiddenGate = overflowHasGate || truncatedKinds.includes('gate_pending');
  const overflowLine = overflow > 0 || truncated
    ? t('flowOverflowLine', {
      count: overflow > 0 ? t(truncated ? 'flowOverflowAtLeast' : 'flowOverflowCount', { overflow }) : t('flowOverflowMaybe'),
      place: hiddenGate ? t('flowOverflowPlaceGate', { tab: tCage('gateTabLabel') }) : t('flowOverflowPlaceQueue'),
    })
    : null;

  return (
    // 4909 (AC3 3단계) — the screen on the ds parts: the panel is the same surface as the approvals list, the head is a SectionHeader (title + the same count rule), the rows are ListRows.
    <div className="overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface">
      <SectionHeader
        // the old kicker («홈») stays as a small muted word before the title (the copy is pinned by the nav-structure ratchet; it is not dropped, only quieter)
        title={<><span className="mr-2 font-mono text-ds-mono-md font-normal text-ds-ink-3">{t('kicker')}</span>{t('title')}</>}
        level={2}
        trailing={!loading && !(loadFailed && shown.length === 0)
          ? <span className="font-sans text-ds-small font-medium text-ds-ink-3">{t.rich('count', { count: shown.length, b: (chunks) => <b className="text-ds-ink">{chunks}</b> })}</span>
          : undefined}
      />

      {loading ? (
        <div>{Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      ) : loadFailed && shown.length === 0 ? (
        // 4909 (가) — 읽기 실패 얼굴. «안전»이 아니라 «못 불러왔어요»(role=alert) + 다시 시도.
        <div role="alert" data-testid="attention-load-failed" className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          <p className="text-ds-body font-semibold text-ds-ink">{t('loadFailedTitle')}</p>
          <p className="text-ds-small text-ds-ink-3">{t('loadFailedBody')}</p>
          {retryButton}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          {/* story #3099(DS·AA 후속) — 텍스트는 중립(ink), 색 신호는 아이콘 하나로 좁힌다(아이콘은 3:1 non-text 기준). */}
          <div className="inline-flex items-center gap-1.5 text-ds-small font-bold tracking-[0.02em] text-ds-ink">
            <ShieldCheck className="size-3.5 text-ds-done" aria-hidden="true" />{t('allClear')}
          </div>
          <p className="text-ds-body font-semibold text-ds-ink-2">{t('emptyTitle')}</p>
          <p className="text-ds-small text-ds-ink-3">{t('emptyBody')}</p>
        </div>
      ) : (
        <div>
          {loadFailed ? (
            <div role="alert" data-testid="attention-load-stale" className="flex items-center gap-3 border-b border-ds-line bg-ds-surface-sunk px-4 py-2.5 text-ds-small text-ds-ink-2">
              <span className="flex-1 break-keep">{t('loadStaleLine')}</span>
              {retryButton}
            </div>
          ) : null}
          {shown.map((item) => (
            <AttentionRow
              key={item.id} item={item} highlighted={highlightedIds.has(item.id)}
              onNavigate={(href) => router.push(href)}
            />
          ))}
          {/* story #2923(P0-E AQ3, doc attention-audit-redesign-2923) — 「결재함=완전 목록 overflow·Attention GATE 앵커」. 상한(cap) 초과분이 사라지지 않고 결재함(gates 탭)에 있다는 걸 클릭 가능한 앵커로 보여준다.
              MEDIUM①(카디르 QA, PR#3353) — overflow가 GATE 버킷 0건이면 앵커 없이 비내비게이션 텍스트로 정직하게 폴백(「거기 전부 있다」로 과장 안 함). 착지 탭 기본값은 안 바꾼다(명시적 tab=gates 링크일 뿐). */}
          {overflowLine && hiddenGate ? (
            <button
              type="button"
              onClick={() => router.push(flatHref('/inbox?tab=gates'))}
              className="flex w-full items-center gap-1.5 border-t border-ds-line bg-ds-surface-sunk px-4 py-2.5 text-left text-ds-small text-ds-ink-3 transition-colors hover:bg-ds-surface-high hover:text-ds-ink-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action focus-visible:outline-none"
            >
              <span className="size-1 rounded-full bg-ds-ink-3" aria-hidden="true" />
              <span className="flex-1 break-keep">{overflowLine}</span>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : overflowLine ? (
            // story #4382(까디르 메모 ①) — 스토리로 묶여 넘침이 0이어도 BE가 잘랐으면 줄이 선다(수는 «더 있을 수 있어요»).
            <div className="flex items-center gap-1.5 border-t border-ds-line bg-ds-surface-sunk px-4 py-2.5 text-ds-small text-ds-ink-3">
              <span className="size-1 rounded-full bg-ds-ink-3" aria-hidden="true" />
              <span className="break-keep">{overflowLine}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
