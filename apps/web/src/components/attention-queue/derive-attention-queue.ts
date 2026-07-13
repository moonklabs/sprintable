import type { ProofState } from '@/components/proof-capsule/proof-capsule';

export type AttentionKind = 'verify_fail' | 'decision_needed' | 'gate_pending' | 'blocked' | 'merge_ready';

export interface AttentionActor {
  name: string;
  isAgent: boolean;
}

export interface AttentionQueueItem {
  id: string;
  kind: AttentionKind;
  kindLabel: string;
  proofState: ProofState;
  claim: string;
  actor: AttentionActor | null;
  actionLabel: string;
  actionTone: 'primary' | 'neutral' | 'ready';
  href: string;
  /** 정렬용 epoch ms. BE `/glance/attention`(P0-04)이 신호에 타임스탬프를 안 실어(정직 미가용)
   * 전부 0 — 동급 티어 내 안정적 후순위(지어낸 최신순 아님). */
  sortKey: number;
}

/** next-intl `useTranslations('attentionQueue')`의 `t` 표면만 뽑은 최소 구조 타입(call-signature) —
 * 파생 함수는 React 밖이라 값으로 주입받는다(derive-exception-signals.ts의 ExceptionLabels 주입
 * 패턴과 동형). 함수 타입 별칭 대신 call-signature로 선언해 next-intl `Translator<M,N>`의 깊은
 * 오버로드 제네릭에 결합하지 않고 테스트의 `createTranslator()` 결과도 그대로 대입 가능
 * (loop-create-dialog.tsx `RecipeTranslator` 선례). */
export interface AttentionQueueTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

/** BE `AttentionItem`(glance.py:36) 미러. scope_violation은 BE가 §7 확定②로 미구현이라 kind
 * 자체가 절대 등장 X. */
export type BeAttentionKind = 'gate_pending' | 'blocked' | 'merge_ready' | 'needs_input' | 'verify_fail';

export interface BeAttentionItem {
  kind: BeAttentionKind;
  story_id: string | null;
  title: string | null;
  ref: Record<string, unknown>;
}

/** AQ가 소비하는 kind 전체(scope_violation은 BE가 §7 확定②로 미구현이라 kind 자체가 절대 미등장 —
 * 별도 필터 불요). `gate_pending`(pending blocking approval)도 "사람 판단 대기"의 대표격이라
 * AQ 결정필요 버킷에 합류(PO 콜 2026-07-13 — 스킵 시 결재가 기다리는데 ALL CLEAR를 띄우는
 * 거짓 표면이 됨). doc `trust-pipeline-be-design` §6 PO amend로 계약 SSOT 정합. */
const KNOWN_KINDS = new Set<BeAttentionKind>(['gate_pending', 'blocked', 'merge_ready', 'needs_input', 'verify_fail']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{data:{items}}`(프록시 wrap) → `{items}`(raw BE) → 둘 다 아니면 그대로.
 * derive-exception-signals.ts의 unwrapEnvelope와 동형(같은 프록시·같은 BE 응답 계약). */
function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

/**
 * 실 payload → 검증된 신호 배열. 형상 불일치는 전부 조용히 생략(throw 0). 제목·story_id 없는
 * 항목은 claim/href를 지어낼 수 없으니 제외(no-fiction). `gate_pending`과 미지 kind는
 * KNOWN_KINDS 밖이라 자동 생략(exception-stream의 동일 원칙 재사용).
 */
export function parseAttentionQueueSignals(json: unknown): BeAttentionItem[] {
  const inner = unwrapEnvelope(json);
  const rawItems = Array.isArray(inner) ? inner : isRecord(inner) ? inner['items'] : null;
  if (!Array.isArray(rawItems)) return [];

  const signals: BeAttentionItem[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw)) continue;
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind as BeAttentionKind)) continue;
    const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
    if (!title) continue;
    const rawStoryId = raw['story_id'];
    const story_id = typeof rawStoryId === 'string' && rawStoryId ? rawStoryId : null;
    if (!story_id) continue; // href/집계 키를 지어낼 수 없으니 제외(no-fiction)
    const ref = isRecord(raw['ref']) ? (raw['ref'] as Record<string, unknown>) : {};
    signals.push({ kind: kind as BeAttentionKind, story_id, title, ref });
  }
  return signals;
}

const PROOF_STATE: Record<AttentionKind, ProofState> = {
  verify_fail: 'amber',
  decision_needed: 'amber',
  gate_pending: 'amber',
  blocked: 'amber',
  merge_ready: 'green',
};

/**
 * 검증된 BE 신호 → AQ 렌더 항목. `needs_input`·`gate_pending` 둘 다 내부 `decision_needed`
 * (기존 i18n 키/카피 무변경) 매핑 — 같은 story에 둘 다 뜨면 story_id 기준 1행으로 합침(개입
 * 사유는 하나, PO 콜 2026-07-13). BE `AttentionItem`엔 assignee 필드가 없어 actor는 항상
 * null(지어내지 않음 — derive-exception-signals.ts의 동일 선택 재사용). `blocked`도 BE가 차단
 * 엣지 1개당 1행을 주므로 story_id별 집계해 실 차단 건수를 claim에 반영(v1 클라 파생과 동일
 * UX·집계 지점만 이동).
 */
export function buildAttentionQueueFromBe(
  signals: BeAttentionItem[],
  t: AttentionQueueTranslator,
): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];
  const blockedByStory = new Map<string, { title: string; count: number }>();
  const decisionNeededByStory = new Map<string, string>(); // story_id → title(첫 등장 것)

  for (const sig of signals) {
    if (!sig.title || !sig.story_id) continue; // 방어적 재확인(parseAttentionQueueSignals가 이미 보장하지만 직접호출 대비)
    if (sig.kind === 'blocked') {
      const entry = blockedByStory.get(sig.story_id) ?? { title: sig.title, count: 0 };
      entry.count += 1;
      blockedByStory.set(sig.story_id, entry);
    } else if (sig.kind === 'needs_input' || sig.kind === 'gate_pending') {
      if (!decisionNeededByStory.has(sig.story_id)) decisionNeededByStory.set(sig.story_id, sig.title);
    } else if (sig.kind === 'verify_fail') {
      items.push({
        id: `verify_fail-${sig.story_id}`, kind: 'verify_fail', kindLabel: t('kindVerifyFail'),
        proofState: PROOF_STATE.verify_fail, claim: t('claimVerifyFail', { title: sig.title }),
        actor: null, actionLabel: t('actionRework'), actionTone: 'neutral',
        href: `/board?story=${sig.story_id}`, sortKey: 0,
      });
    } else if (sig.kind === 'merge_ready') {
      items.push({
        id: `merge_ready-${sig.story_id}`, kind: 'merge_ready', kindLabel: t('kindMergeReady'),
        proofState: PROOF_STATE.merge_ready, claim: t('claimMergeReady', { title: sig.title }),
        actor: null, actionLabel: t('actionMerge'), actionTone: 'ready',
        href: `/board?story=${sig.story_id}`, sortKey: 0,
      });
    }
  }

  for (const [storyId, { title, count }] of blockedByStory) {
    items.push({
      id: `blocked-${storyId}`, kind: 'blocked', kindLabel: t('kindBlocked'),
      proofState: PROOF_STATE.blocked, claim: t('claimBlocked', { title, count }),
      actor: null, actionLabel: t('actionCoordinate'), actionTone: 'neutral',
      href: `/board?story=${storyId}`, sortKey: 0,
    });
  }
  for (const [storyId, title] of decisionNeededByStory) {
    items.push({
      id: `decision_needed-${storyId}`, kind: 'decision_needed', kindLabel: t('kindDecisionNeeded'),
      proofState: PROOF_STATE.decision_needed, claim: t('claimDecisionNeeded', { title }),
      actor: null, actionLabel: t('actionDecide'), actionTone: 'primary',
      href: `/board?story=${storyId}`, sortKey: 0,
    });
  }
  return items;
}

/**
 * SSE `story.trust_stage_changed`(9ef0f914 — 이벤트는 트리거, 진실은 서버) 수신 後 `/glance/attention`
 * 단발 재조회 결과를 이전 리스트와 비교 — **신규 등장 또는 claim 텍스트가 바뀐 행의 id만** 반환.
 * 소비측(attention-queue-view.tsx)이 이 id들만 1회 하이라이트하고 나머지는 무반짝(全행 반짝 금지
 * 모션 규율). 제거된 행은 별도 표시 없이 그냥 사라짐(제거 자체가 충분한 신호).
 */
export function diffAttentionQueueItemIds(
  prev: AttentionQueueItem[],
  next: AttentionQueueItem[],
): Set<string> {
  const prevClaimById = new Map(prev.map((item) => [item.id, item.claim]));
  const changed = new Set<string>();
  for (const item of next) {
    const prevClaim = prevClaimById.get(item.id);
    if (prevClaim === undefined || prevClaim !== item.claim) changed.add(item.id);
  }
  return changed;
}

const KIND_PRIORITY: Record<AttentionKind, number> = {
  verify_fail: 0, decision_needed: 0, gate_pending: 0, blocked: 0, merge_ready: 1,
};

/**
 * 우선순위(amber 3종 > green 1종) 정렬 후 3~7 상한 cap. 미달이어도 억지로 안 채우고(스펙 §4),
 * 초과분은 "흐름" 강등 카운트(overflow)로만 — 별도 fabricated activity 지표 없음.
 */
export function buildAttentionQueue(
  items: AttentionQueueItem[],
  cap = 7,
): { shown: AttentionQueueItem[]; overflow: number } {
  const sorted = [...items].sort((a, b) => {
    const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    return p !== 0 ? p : b.sortKey - a.sortKey;
  });
  return { shown: sorted.slice(0, cap), overflow: Math.max(0, sorted.length - cap) };
}
