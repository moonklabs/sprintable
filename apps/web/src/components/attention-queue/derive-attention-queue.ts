import type { ProofState } from '@/components/proof-capsule/proof-capsule';

// story #2923(P0-E AQ1) — DecisionsWaiting(/api/inbox)이 흡수하는 4종 kind를 기존 5종에 합류.
// approval/decision/blocker/mention은 doc attention-audit-redesign-2923(2026-08-22 PO 정본
// 반영)의 9→4 버킷표에 따라 각각 GATE/STEER/BLOCK/Q에 귀속된다(아래 AttentionBucket).
export type AttentionKind =
  | 'verify_fail' | 'decision_needed' | 'gate_pending' | 'blocked' | 'merge_ready'
  | 'approval' | 'decision' | 'blocker' | 'mention';

/** story #2923 AQ1 — "사용자가 요구받는 판단의 종류" 축(PO 매핑표 정본, 2026-08-22).
 * AQ2가 이 값을 실제 배지로 렌더한다(이 슬라이스는 데이터 계층만 — 시각화 아님). */
export type AttentionBucket = 'GATE' | 'STEER' | 'BLOCK' | 'Q';

export interface AttentionActor {
  name: string;
  isAgent: boolean;
}

export interface AttentionQueueItem {
  id: string;
  kind: AttentionKind;
  bucket: AttentionBucket;
  kindLabel: string;
  proofState: ProofState;
  claim: string;
  actor: AttentionActor | null;
  actionLabel: string;
  actionTone: 'primary' | 'neutral' | 'ready';
  /** story #2923 AQ1(PO 실측, 2026-08-22) — inbox 병합 항목 중 origin_chain이 story/memo
   * 어느 쪽도 없으면(run/initiative만 있으면) 상세 라우트가 FE에 아예 없다(notification-
   * navigation도 doc 계열만 다룸, 지어내지 않음) — null이면 호출부가 행 자체를 비내비게이션
   * 처리(버튼 비표시)한다. 기존 BE 신호(story_id 필수)는 항상 non-null. */
  href: string | null;
  /** story #2249 — 「그 상태에 들어간 시각」epoch ms(모르면 null. blocked는 BE가 항상 값을
   * 안 실어 null — glance.py 모듈 docstring: 재진입 시각 미기록이라 "모름"이지 근사 아님). FE는
   * null 여부만으로 갈라 쓴다("exact"|null 두 상태뿐 — BE에 "approx"는 존재하지 않음, precision
   * 필드는 그 값과 완전히 종속이라 별도로 안 읽는다). */
  enteredStateAtMs: number | null;
  /** 정렬용 경과시간(ms) — enteredStateAtMs 있으면 now-그값(체류시간이 위계를 만든다, 클수록
   * 먼저), 없으면(모름) 0으로 동급 티어 내 안정적 후순위. */
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
  /** story #2249 — glance.py `AttentionItem.entered_state_at`(UTC ISO). 없으면 null(모름). */
  entered_state_at: string | null;
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
    const rawEnteredAt = raw['entered_state_at'];
    const entered_state_at = typeof rawEnteredAt === 'string' ? rawEnteredAt : null;
    signals.push({ kind: kind as BeAttentionKind, story_id, title, ref, entered_state_at });
  }
  return signals;
}

const KNOWN_INBOX_KINDS = new Set<InboxItemKind>(['approval', 'decision', 'blocker', 'mention']);

/** story #2923 AQ1 — `/api/inbox` 실 payload(`{data:[...]}`) → 검증된 InboxAttentionItem
 * 배열. unwrapEnvelope 재사용(`data`가 배열이면 그대로 배열째 반환하는 기존 동작이 이 응답
 * 형상과 그대로 맞는다). 형상 불일치는 조용히 생략(throw 0, parseAttentionQueueSignals와
 * 동형 원칙) — id/title 없는 항목은 claim/집계 키를 지어낼 수 없으니 제외. */
export function parseInboxAttentionItems(json: unknown): InboxAttentionItem[] {
  const inner = unwrapEnvelope(json);
  if (!Array.isArray(inner)) return [];

  const items: InboxAttentionItem[] = [];
  for (const raw of inner) {
    if (!isRecord(raw)) continue;
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !KNOWN_INBOX_KINDS.has(kind as InboxItemKind)) continue;
    const id = typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : null;
    if (!id) continue;
    const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
    if (!title) continue;
    const rawChain = Array.isArray(raw['origin_chain']) ? raw['origin_chain'] : [];
    const origin_chain: InboxOriginNode[] = [];
    for (const node of rawChain) {
      if (!isRecord(node)) continue;
      const type = node['type'];
      const nodeId = node['id'];
      if (typeof type === 'string' && ['memo', 'story', 'run', 'initiative'].includes(type) && typeof nodeId === 'string' && nodeId) {
        origin_chain.push({ type: type as InboxOriginType, id: nodeId });
      }
    }
    const created_at = typeof raw['created_at'] === 'string' ? raw['created_at'] : '';
    if (!created_at) continue; // 정렬키를 지어낼 수 없으니 제외(no-fiction)
    items.push({ id, kind: kind as InboxItemKind, title, origin_chain, created_at });
  }
  return items;
}

/** ISO 문자열 → epoch ms(모르면 null). 파싱 실패도 모름으로 취급(지어내지 않음). */
function toEpochMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** enteredStateAtMs → 정렬키(경과시간 ms). 모르면 0(동급 티어 내 안정적 후순위). */
function toSortKey(enteredStateAtMs: number | null): number {
  return enteredStateAtMs === null ? 0 : Math.max(0, Date.now() - enteredStateAtMs);
}

const PROOF_STATE: Record<AttentionKind, ProofState> = {
  verify_fail: 'amber',
  decision_needed: 'amber',
  gate_pending: 'amber',
  blocked: 'amber',
  merge_ready: 'green',
  // story #2923 AQ1 — inbox 4종은 전부 "아직 판단 대기"(merge_ready 같은 "좋은 소식" 뉘앙스가
  // 없다 — DecisionsWaiting도 항상 warning 톤 패널이었다) — amber로 통일, 지어내지 않음.
  approval: 'amber', decision: 'amber', blocker: 'amber', mention: 'amber',
};

/** story #2923 AQ1 — PO 매핑표(2026-08-22 정본, doc attention-audit-redesign-2923) 그대로.
 * gate_pending/needs_input이 decision_needed로 합쳐지는 기존 dedup(PO 콜 2026-07-13)은
 * 안 건드린다 — 합쳐지기 전 원신호의 kind로 버킷을 가른다. 카디르 QA(PR#3352) 정정 —
 * "먼저 도착한 신호" 아님: gate_pending이 도착 순서와 무관하게 항상 GATE로 단방향 승격된다
 * (PO 리뷰 처방, 아래 buildAttentionQueueFromBe의 existing.originKind 갱신 로직 참고 —
 * needs_input이 먼저 와도 gate_pending이 나중에 오면 GATE로 전환, 역방향 강등은 없음). */
export const BUCKET_BY_KIND: Record<AttentionKind, AttentionBucket> = {
  gate_pending: 'GATE', merge_ready: 'GATE', approval: 'GATE',
  decision_needed: 'STEER', decision: 'STEER',
  verify_fail: 'BLOCK', blocked: 'BLOCK', blocker: 'BLOCK',
  mention: 'Q',
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
  const blockedByStory = new Map<string, { title: string; count: number; enteredAtMs: number | null }>();
  // story_id → { title, enteredAtMs, originKind }. title/enteredAtMs는 첫 등장 것(first-wins,
  // 무변경). originKind는 다르다 — 카디르 QA(PR#3352) 정정: "먼저 온 신호 기준"이 아니라
  // gate_pending 단방향 우선(아래 루프에서 gate_pending이 나중에 와도 승격, 역방향 강등 없음).
  // decision_needed로 합쳐지기 전의 원신호를 기억해 둔다 — 합쳐진 뒤엔 GATE vs STEER 구분이
  // 불가하므로.
  const decisionNeededByStory = new Map<string, { title: string; enteredAtMs: number | null; originKind: 'gate_pending' | 'needs_input' }>();

  for (const sig of signals) {
    if (!sig.title || !sig.story_id) continue; // 방어적 재확인(parseAttentionQueueSignals가 이미 보장하지만 직접호출 대비)
    const enteredAtMs = toEpochMs(sig.entered_state_at);
    if (sig.kind === 'blocked') {
      // BE는 blocked에 entered_state_at을 항상 안 실어(재진입 시각 미기록 — glance.py 참조) 지금은
      // 항상 null이지만, 나중에 재료가 생기면(#2256) 이 자리가 자동으로 값을 받는다 — "가장 먼저
      // 막힌 엣지"가 이 story가 막힌 지 얼마나 됐는지를 가장 잘 대표하므로 min(가장 이른 시각)을 쓴다.
      const entry = blockedByStory.get(sig.story_id) ?? { title: sig.title, count: 0, enteredAtMs: null };
      entry.count += 1;
      if (enteredAtMs !== null && (entry.enteredAtMs === null || enteredAtMs < entry.enteredAtMs)) {
        entry.enteredAtMs = enteredAtMs;
      }
      blockedByStory.set(sig.story_id, entry);
    } else if (sig.kind === 'needs_input' || sig.kind === 'gate_pending') {
      const existing = decisionNeededByStory.get(sig.story_id);
      if (!existing) {
        decisionNeededByStory.set(sig.story_id, { title: sig.title, enteredAtMs, originKind: sig.kind });
      } else if (sig.kind === 'gate_pending' && existing.originKind !== 'gate_pending') {
        // PO 리뷰(PR#3352, 2026-08-22) — title/enteredAtMs는 여전히 first-wins(위 !existing
        // 분기, 변경 없음)지만 originKind(=버킷)만은 BE 배열 도착 순서라는 우연에 맡기지 않는다.
        // needs_input이 먼저 와도 gate_pending이 나중에 뜨면 GATE로 승격한다 — 결재 대기(GATE)가
        // 입력 대기(STEER)보다 개입 의미가 강해, 순서와 무관하게 더 강한 신호가 이겨야 한다.
        existing.originKind = 'gate_pending';
      }
    } else if (sig.kind === 'verify_fail') {
      items.push({
        id: `verify_fail-${sig.story_id}`, kind: 'verify_fail', bucket: BUCKET_BY_KIND.verify_fail, kindLabel: t('kindVerifyFail'),
        proofState: PROOF_STATE.verify_fail, claim: t('claimVerifyFail', { title: sig.title }),
        actor: null, actionLabel: t('actionRework'), actionTone: 'neutral',
        href: `/board?story=${sig.story_id}`, enteredStateAtMs: enteredAtMs, sortKey: toSortKey(enteredAtMs),
      });
    } else if (sig.kind === 'merge_ready') {
      items.push({
        id: `merge_ready-${sig.story_id}`, kind: 'merge_ready', bucket: BUCKET_BY_KIND.merge_ready, kindLabel: t('kindMergeReady'),
        proofState: PROOF_STATE.merge_ready, claim: t('claimMergeReady', { title: sig.title }),
        actor: null, actionLabel: t('actionMerge'), actionTone: 'ready',
        href: `/board?story=${sig.story_id}`, enteredStateAtMs: enteredAtMs, sortKey: toSortKey(enteredAtMs),
      });
    }
  }

  for (const [storyId, { title, count, enteredAtMs }] of blockedByStory) {
    items.push({
      id: `blocked-${storyId}`, kind: 'blocked', bucket: BUCKET_BY_KIND.blocked, kindLabel: t('kindBlocked'),
      proofState: PROOF_STATE.blocked, claim: t('claimBlocked', { title, count }),
      actor: null, actionLabel: t('actionCoordinate'), actionTone: 'neutral',
      href: `/board?story=${storyId}`, enteredStateAtMs: enteredAtMs, sortKey: toSortKey(enteredAtMs),
    });
  }
  for (const [storyId, { title, enteredAtMs, originKind }] of decisionNeededByStory) {
    items.push({
      // originKind는 'gate_pending'|'needs_input'(BeAttentionKind 부분집합)이라 AttentionKind
      // 전체를 키로 삼는 BUCKET_BY_KIND엔 'needs_input' 항목이 없다(item.kind로 실제 등장하는
      // 값이 아니라서 그 테이블에 넣지 않았다) — 여기서만 직접 분기.
      id: `decision_needed-${storyId}`, kind: 'decision_needed', bucket: originKind === 'gate_pending' ? 'GATE' : 'STEER', kindLabel: t('kindDecisionNeeded'),
      proofState: PROOF_STATE.decision_needed, claim: t('claimDecisionNeeded', { title }),
      actor: null, actionLabel: t('actionDecide'), actionTone: 'primary',
      href: `/board?story=${storyId}`, enteredStateAtMs: enteredAtMs, sortKey: toSortKey(enteredAtMs),
    });
  }
  return items;
}

// story #2923(P0-E AQ1) — DecisionsWaiting(/api/inbox)이 흡수되는 원본 타입. 다건 옵션
// resolve(approve/approve-alt/reassign/changes)·dismiss는 PO 확定①(2026-08-22, "단순화")로
// row에 안 옮긴다 — row는 단일 버튼(상세 이동)만, 신중 결재(다건 사유)는 상세 화면 몫(게이트
// 「확認과 비가역을 한 호출에 안 묶는」 규율과 같은 결). options/priority 필드는 그래서 이
// 병합에서 안 씀(지어내지 않음 — 쓰지도 않을 필드를 타입에 안 얹는다).
export type InboxItemKind = 'approval' | 'decision' | 'blocker' | 'mention';
export type InboxOriginType = 'memo' | 'story' | 'run' | 'initiative';

export interface InboxOriginNode {
  type: InboxOriginType;
  id: string;
}

export interface InboxAttentionItem {
  id: string;
  kind: InboxItemKind;
  title: string;
  origin_chain: InboxOriginNode[];
  created_at: string;
}

/** story #2923 AQ1(PO 실측, 2026-08-22) — origin_chain에서 상세 라우트가 실재하는 노드만
 * 찾아 href를 만든다. 우선순위: story(기존 `/board?story=` 관례) > memo(doc 실물 — id→slug
 * 사전 해소된 맵 필요, notification-navigation.ts의 buildDocHref 관례) > 없음(run/initiative는
 * FE 상세 라우트 자체가 없다 — notification-navigation도 doc 계열만 다루고, 현행
 * DecisionsWaiting조차 origin을 링크 아닌 텍스트 라벨로만 보여줬다. 있지도 않은 라우트를
 * 지어내지 않는다 — null이면 호출부가 행을 비내비게이션 처리). */
export function resolveInboxItemHref(
  originChain: InboxOriginNode[],
  docSlugById: Map<string, string>,
): string | null {
  const story = originChain.find((n) => n.type === 'story');
  if (story) return `/board?story=${story.id}`;
  const memo = originChain.find((n) => n.type === 'memo');
  if (memo) {
    const slug = docSlugById.get(memo.id);
    if (slug) return `/docs/${slug}`;
  }
  return null;
}

/** story #2923 AQ1(카디르 QA HIGH2, PR#3352 2026-08-22 처방 — 같은 라운드 MEDIUM 2건 추가
 * 처방 포함) — gate_pending(Gate 1차 소스)과 approval(inbox_items, 외부 producer)이 같은
 * story에 대해 동시 존재하면 같은 사실이 두 행으로 중복 노출된다. Gate가 1차 소스라
 * gate_pending 우선·겹치는 inbox approval은 drop한다. merge_ready(=CI 통과·병합 준비)는
 * 대상 밖 — "결재 대기 중"이라는 같은 사실이 아니라 다른 lifecycle 사실이라, gate_pending과
 * 달리 approval과 진짜 중복이 아니다(지어내지 않음).
 *
 * origin_chain에 story가 없는 approval(inbox_items가 story 귀속을 안 줌 — memo/run/initiative
 * 기반)은 dedup 판정 자체가 불가능하므로 그대로 둔다(둘 다 노출이 정직 — 근거 없이 지우지
 * 않음).
 *
 * MEDIUM①: origin_chain에 story 노드가 여러 개일 수 있는데 `.find`는 첫 번째만 봐서 두 번째
 * 이후 story가 gate_pending과 겹쳐도 못 잡았다 — `.some`으로 전부 검사.
 * MEDIUM②: Gate의 story_id는 항상 lowercase UUID(DB 관례)인데 inbox_items의 origin_chain은
 * 외부 producer가 채워 형식 제약이 없다(대문자 UUID 등) — 대소문자만 다른 같은 story가
 * 안 겹쳐 보일 수 있어 양쪽 다 `.toLowerCase()`로 정규화 후 비교(UUID 아닌 id 문자열에도
 * 무해 — 단순 소문자화라 형식 가정 자체가 없다). */
export function dedupInboxApprovalsAgainstGatePending(
  inboxItems: InboxAttentionItem[],
  gatePendingStoryIds: Set<string>,
): InboxAttentionItem[] {
  const normalizedGateIds = new Set([...gatePendingStoryIds].map((id) => id.toLowerCase()));
  return inboxItems.filter((item) => {
    if (item.kind !== 'approval') return true;
    const storyNodes = item.origin_chain.filter((n) => n.type === 'story');
    if (storyNodes.length === 0) return true;
    return !storyNodes.some((story) => normalizedGateIds.has(story.id.toLowerCase()));
  });
}

const INBOX_ITEM_META: Record<InboxItemKind, { kindLabelKey: string; actionLabelKey: string; actionTone: 'primary' | 'neutral' }> = {
  approval: { kindLabelKey: 'kindApproval', actionLabelKey: 'actionApprove', actionTone: 'primary' },
  decision: { kindLabelKey: 'kindDecision', actionLabelKey: 'actionConfirm', actionTone: 'primary' },
  blocker: { kindLabelKey: 'kindBlocker', actionLabelKey: 'actionResolve', actionTone: 'neutral' },
  mention: { kindLabelKey: 'kindMention', actionLabelKey: 'actionReply', actionTone: 'neutral' },
};

/** story #2923 AQ1 — DecisionsWaiting 패널 폐기, 그 데이터를 AQ 행으로 흡수. item.title은
 * BE가 이미 완결된 설명 문자열이라(DecisionsWaiting 기존 렌더도 그대로 썼다) claimXxx 템플릿
 * 래핑 없이 그대로 claim으로 쓴다(BE raw entity title을 감싸야 했던 verify_fail류와 다름). */
export function buildAttentionQueueFromInbox(
  items: InboxAttentionItem[],
  t: AttentionQueueTranslator,
  docSlugById: Map<string, string>,
): AttentionQueueItem[] {
  return items.map((item) => {
    const meta = INBOX_ITEM_META[item.kind];
    const enteredAtMs = toEpochMs(item.created_at);
    return {
      id: `inbox-${item.id}`,
      kind: item.kind,
      bucket: BUCKET_BY_KIND[item.kind],
      kindLabel: t(meta.kindLabelKey),
      proofState: PROOF_STATE[item.kind],
      claim: item.title,
      actor: null,
      actionLabel: t(meta.actionLabelKey),
      actionTone: meta.actionTone,
      href: resolveInboxItemHref(item.origin_chain, docSlugById),
      enteredStateAtMs: enteredAtMs,
      sortKey: toSortKey(enteredAtMs),
    };
  });
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

// story #2923 AQ1 — inbox 4종은 기존 amber 3종과 동일 우선순위 티어(0)에 둔다. 위험·나이 기반
// 정밀 정렬은 AQ5 스코프("「3~7」 상한: 우선순위 정렬")라 여기서 새로 설계하지 않는다.
const KIND_PRIORITY: Record<AttentionKind, number> = {
  verify_fail: 0, decision_needed: 0, gate_pending: 0, blocked: 0, merge_ready: 1,
  approval: 0, decision: 0, blocker: 0, mention: 0,
};

/**
 * 우선순위(amber 3종 > green 1종) 정렬 후 3~7 상한 cap. 미달이어도 억지로 안 채우고(스펙 §4),
 * 초과분은 "흐름" 강등 카운트(overflow)로만 — 별도 fabricated activity 지표 없음.
 */
/** story #2923 AQ3 MEDIUM①(카디르 QA, PR#3353 2026-08-22 처방) — overflow로 잘린 항목 중
 * GATE 버킷이 1개라도 있어야 결재함(gates 탭) 앵커가 정직하다(결재함=Gate 3종 완전 목록이라
 * GATE 아닌 잘린 항목은 거기 없다). 0건이면 앵커 자체를 안 보여준다(호출부가 기존 비내비게이션
 * 텍스트로 폴백) — bucket 필드(AQ1)가 이제 있어 가능해진 정밀 판정. */
export function buildAttentionQueue(
  items: AttentionQueueItem[],
  cap = 7,
): { shown: AttentionQueueItem[]; overflow: number; overflowHasGate: boolean } {
  const sorted = [...items].sort((a, b) => {
    const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    return p !== 0 ? p : b.sortKey - a.sortKey;
  });
  const cut = sorted.slice(cap);
  return {
    shown: sorted.slice(0, cap),
    overflow: Math.max(0, cut.length),
    overflowHasGate: cut.some((item) => item.bucket === 'GATE'),
  };
}
