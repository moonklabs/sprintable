import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  parseAttentionQueueSignals, buildAttentionQueueFromBe, buildAttentionQueue, diffAttentionQueueItemIds,
  parseInboxAttentionItems, resolveInboxItemHref, buildAttentionQueueFromInbox,
  BUCKET_BY_KIND,
  type BeAttentionItem, type AttentionQueueItem, type AttentionQueueTranslator,
} from './derive-attention-queue';
import koMessagesRaw from '../../../messages/ko.json';
import enMessagesRaw from '../../../messages/en.json';

// production `t` (useTranslations()) resolves against the permissive default `IntlMessages`
// generic (no global next-intl message-type augmentation in this repo) — cast here so the test
// translator has the same loose type instead of the JSON import's inferred literal-key type.
type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const enMessages = enMessagesRaw as unknown as LooseMessages;
// next-intl's Translator<M,N> overload set doesn't structurally satisfy our minimal
// AttentionQueueTranslator call-signature for a non-literal LooseMessages import (same
// friction as loop-create-dialog.test.tsx's RecipeTranslator) — cast at the boundary, runtime
// behavior is unaffected (createTranslator's t(key, values) works exactly as at production).
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'attentionQueue' }) as unknown as AttentionQueueTranslator;
const tEn = createTranslator({ locale: 'en', messages: enMessages, namespace: 'attentionQueue' }) as unknown as AttentionQueueTranslator;

function beItem(overrides: Partial<BeAttentionItem> = {}): BeAttentionItem {
  return { kind: 'verify_fail', story_id: 'story-1', title: '결제 복구 플로우', ref: {}, entered_state_at: null, ...overrides };
}

describe('parseAttentionQueueSignals', () => {
  it('unwraps the double-wrapped {data:{items}} proxy envelope', () => {
    const items = parseAttentionQueueSignals({ data: { items: [beItem()] } });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('verify_fail');
  });

  it('unwraps the raw BE {items} shape (no proxy wrap)', () => {
    const items = parseAttentionQueueSignals({ items: [beItem({ kind: 'blocked' })] });
    expect(items).toHaveLength(1);
  });

  it('returns [] for malformed shapes (no items array anywhere) — throw 0', () => {
    expect(parseAttentionQueueSignals(null)).toEqual([]);
    expect(parseAttentionQueueSignals(undefined)).toEqual([]);
    expect(parseAttentionQueueSignals({ foo: 'bar' })).toEqual([]);
    expect(parseAttentionQueueSignals('not an object')).toEqual([]);
  });

  it('keeps all 5 known BE kinds including gate_pending (PO 콜: 결정필요 버킷 합류)', () => {
    const items = parseAttentionQueueSignals({
      items: [
        beItem({ kind: 'gate_pending' }),
        beItem({ kind: 'blocked' }),
        beItem({ kind: 'merge_ready' }),
        beItem({ kind: 'needs_input' }),
        beItem({ kind: 'verify_fail' }),
      ],
    });
    expect(items).toHaveLength(5);
  });

  it('skips unknown/malformed kinds without crashing (no-fiction)', () => {
    const items = parseAttentionQueueSignals({
      items: [beItem(), { kind: 'scope_violation', story_id: 's', title: 't', ref: {} }, { kind: 123 }],
    });
    expect(items).toHaveLength(1);
  });

  it('skips items missing title or story_id (cannot fabricate claim/href)', () => {
    const items = parseAttentionQueueSignals({
      items: [
        beItem({ title: null }),
        beItem({ title: '' }),
        beItem({ story_id: null }),
      ],
    });
    expect(items).toHaveLength(0);
  });

  it('story #2249 — extracts entered_state_at when present as an ISO string', () => {
    const items = parseAttentionQueueSignals({
      items: [beItem({ entered_state_at: '2026-07-26T00:00:00.000Z' })],
    });
    expect(items[0]!.entered_state_at).toBe('2026-07-26T00:00:00.000Z');
  });

  it('story #2249 — defaults entered_state_at to null when absent or malformed (모름, 지어내지 않음)', () => {
    const items = parseAttentionQueueSignals({
      items: [beItem({ entered_state_at: undefined }), beItem({ entered_state_at: 12345 as unknown as null })],
    });
    expect(items[0]!.entered_state_at).toBeNull();
    expect(items[1]!.entered_state_at).toBeNull();
  });
});

describe('buildAttentionQueueFromBe', () => {
  it('maps verify_fail to an amber/neutral-tone item', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'verify_fail' })], t);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('verify_fail');
    expect(items[0]!.proofState).toBe('amber');
    expect(items[0]!.actionTone).toBe('neutral');
    expect(items[0]!.claim).toContain('결제 복구 플로우');
    expect(items[0]!.actor).toBeNull(); // BE AttentionItem엔 assignee 필드 없음(no-fiction)
    expect(items[0]!.href).toBe('/board?story=story-1');
  });

  it('maps merge_ready to a green/ready-tone item', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'merge_ready' })], t);
    expect(items[0]!.kind).toBe('merge_ready');
    expect(items[0]!.proofState).toBe('green');
    expect(items[0]!.actionTone).toBe('ready');
  });

  it('maps needs_input to internal decision_needed (amber/primary-tone)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'needs_input' })], t);
    expect(items[0]!.kind).toBe('decision_needed');
    expect(items[0]!.actionTone).toBe('primary');
  });

  it('maps gate_pending to internal decision_needed too (PO 콜: 스킵 대신 결정필요 합류)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'gate_pending' })], t);
    expect(items[0]!.kind).toBe('decision_needed');
  });

  it('merges gate_pending + needs_input on the same story into one decision_needed row', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'gate_pending', story_id: 'story-1' }),
      beItem({ kind: 'needs_input', story_id: 'story-1' }),
    ], t);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('decision_needed');
  });

  it('keeps decision_needed rows for distinct stories separate', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'needs_input', story_id: 'story-1' }),
      beItem({ kind: 'gate_pending', story_id: 'story-2', title: '온보딩 위저드' }),
    ], t);
    expect(items).toHaveLength(2);
  });

  it('aggregates multiple blocked edges for the same story into one row with the real blocker count', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'blocked', story_id: 'story-1' }),
      beItem({ kind: 'blocked', story_id: 'story-1' }),
    ], t);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('blocked');
    expect(items[0]!.claim).toContain('2건');
    expect(items[0]!.claim).toContain('결제 복구 플로우');
  });

  it('renders claim/kindLabel/actionLabel in English when given the en translator (ko/en parity)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'verify_fail' })], tEn);
    expect(items[0]!.kindLabel).toBe('Verify failed');
    expect(items[0]!.actionLabel).toBe('Send back');
    expect(items[0]!.claim).toContain('CI check failed');
    expect(items[0]!.claim).not.toContain('CI 검증 실패');
  });

  it('renders the blocked count in English when given the en translator', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'blocked', story_id: 'story-1' }),
      beItem({ kind: 'blocked', story_id: 'story-1' }),
    ], tEn);
    expect(items[0]!.claim).toContain('blocked by 2');
  });

  it('story #2249 — threads entered_state_at into enteredStateAtMs for 1:1 kinds (verify_fail/merge_ready)', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'verify_fail', entered_state_at: '2026-07-26T00:00:00.000Z' }),
    ], t);
    expect(items[0]!.enteredStateAtMs).toBe(Date.parse('2026-07-26T00:00:00.000Z'));
    expect(items[0]!.sortKey).toBeGreaterThan(0);
  });

  it('story #2249 — enteredStateAtMs/sortKey stay null/0 when entered_state_at is unknown (blocked 등)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'blocked', entered_state_at: null })], t);
    expect(items[0]!.enteredStateAtMs).toBeNull();
    expect(items[0]!.sortKey).toBe(0);
  });

  it('story #2249 — blocked 집계는 여러 신호 중 가장 이른(min) entered_state_at을 쓴다', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'blocked', story_id: 'story-1', entered_state_at: '2026-07-27T00:00:00.000Z' }),
      beItem({ kind: 'blocked', story_id: 'story-1', entered_state_at: '2026-07-25T00:00:00.000Z' }),
    ], t);
    expect(items[0]!.enteredStateAtMs).toBe(Date.parse('2026-07-25T00:00:00.000Z'));
  });

  it('story #2249 — decision_needed는 먼저 등장한 신호(gate_pending/needs_input)의 entered_state_at을 쓴다', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'gate_pending', story_id: 'story-1', entered_state_at: '2026-07-26T00:00:00.000Z' }),
      beItem({ kind: 'needs_input', story_id: 'story-1', entered_state_at: '2026-07-28T00:00:00.000Z' }),
    ], t);
    expect(items[0]!.enteredStateAtMs).toBe(Date.parse('2026-07-26T00:00:00.000Z'));
  });
});

describe('buildAttentionQueue', () => {
  function item(kind: AttentionQueueItem['kind'], sortKey: number): AttentionQueueItem {
    return {
      id: `${kind}-${sortKey}`, kind, bucket: BUCKET_BY_KIND[kind], kindLabel: kind, proofState: kind === 'merge_ready' ? 'green' : 'amber',
      claim: kind, actor: null, actionLabel: '가기', actionTone: 'neutral', href: '/board',
      enteredStateAtMs: null, sortKey,
    };
  }

  it('sorts amber-tier items before merge_ready (green), longest-elapsed(체류시간)-first within a tier', () => {
    const { shown } = buildAttentionQueue([
      item('merge_ready', 100),
      item('verify_fail', 10),
      item('blocked', 20),
    ]);
    expect(shown.map((i) => i.kind)).toEqual(['blocked', 'verify_fail', 'merge_ready']);
  });

  it('caps at 7 and reports the honest overflow count (not a fabricated activity metric)', () => {
    const items = Array.from({ length: 10 }, (_, i) => item('decision_needed', i));
    const { shown, overflow } = buildAttentionQueue(items);
    expect(shown).toHaveLength(7);
    expect(overflow).toBe(3);
  });

  it('does not pad below 3 — an honestly-small queue stays small', () => {
    const { shown, overflow } = buildAttentionQueue([item('verify_fail', 1)]);
    expect(shown).toHaveLength(1);
    expect(overflow).toBe(0);
  });
});

describe('diffAttentionQueueItemIds (9ef0f914 — SSE-triggered refetch diff)', () => {
  function item(id: string, claim: string): AttentionQueueItem {
    return {
      id, kind: 'blocked', bucket: 'BLOCK', kindLabel: '막힘', proofState: 'amber', claim,
      actor: null, actionLabel: '조율', actionTone: 'neutral', href: '/board',
      enteredStateAtMs: null, sortKey: 0,
    };
  }

  it('marks a newly-appeared id as changed', () => {
    const changed = diffAttentionQueueItemIds([], [item('a', 'x')]);
    expect(changed).toEqual(new Set(['a']));
  });

  it('marks an id whose claim text changed, and leaves unchanged ids out (no full-list flash)', () => {
    const prev = [item('a', 'old claim'), item('b', 'stable claim')];
    const next = [item('a', 'new claim'), item('b', 'stable claim')];
    expect(diffAttentionQueueItemIds(prev, next)).toEqual(new Set(['a']));
  });

  it('returns an empty set when nothing changed (no spurious highlight)', () => {
    const list = [item('a', 'same'), item('b', 'same2')];
    expect(diffAttentionQueueItemIds(list, list)).toEqual(new Set());
  });

  it('does not mark removed ids (removal itself is the signal — no separate flash needed)', () => {
    const prev = [item('a', 'x'), item('b', 'y')];
    const next = [item('a', 'x')];
    expect(diffAttentionQueueItemIds(prev, next)).toEqual(new Set());
  });
});

// story #2923(P0-E AQ1, PO 9→4 매핑표 정본 2026-08-22) — GATE=gate_pending·merge_ready·approval
// / STEER=decision·needs_input / BLOCK=verify_fail·blocked·blocker / Q=mention.
describe('buildAttentionQueueFromBe (story #2923 AQ1 — bucket 판정)', () => {
  it('verify_fail → BLOCK, blocked → BLOCK, merge_ready → GATE', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'verify_fail', story_id: 's1' }),
      beItem({ kind: 'blocked', story_id: 's2' }),
      beItem({ kind: 'merge_ready', story_id: 's3' }),
    ], t);
    const bucketByKind = Object.fromEntries(items.map((i) => [i.kind, i.bucket]));
    expect(bucketByKind['verify_fail']).toBe('BLOCK');
    expect(bucketByKind['blocked']).toBe('BLOCK');
    expect(bucketByKind['merge_ready']).toBe('GATE');
  });

  it('gate_pending origin → decision_needed row bucketed GATE (합쳐지기 전 원신호 기억)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'gate_pending', story_id: 's1' })], t);
    expect(items[0]!.kind).toBe('decision_needed');
    expect(items[0]!.bucket).toBe('GATE');
  });

  it('needs_input origin → decision_needed row bucketed STEER (gate_pending과 버킷이 갈린다)', () => {
    const items = buildAttentionQueueFromBe([beItem({ kind: 'needs_input', story_id: 's1' })], t);
    expect(items[0]!.kind).toBe('decision_needed');
    expect(items[0]!.bucket).toBe('STEER');
  });

  it('같은 story에 gate_pending이 먼저 도착하면 needs_input이 뒤이어 와도 GATE 버킷을 유지한다(title/enteredAtMs는 여전히 first-wins, dedup 자체는 무변경)', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'gate_pending', story_id: 's1' }),
      beItem({ kind: 'needs_input', story_id: 's1' }),
    ], t);
    expect(items).toHaveLength(1);
    expect(items[0]!.bucket).toBe('GATE');
  });

  // PO 리뷰(PR#3352, 2026-08-22) — 버킷이 BE 배열 «도착 순서»라는 우연에 결박되면 안 된다.
  // needs_input이 먼저 와도 gate_pending이 나중에 도착하면 GATE로 승격돼야 한다(결재 대기가
  // 입력 대기보다 개입 의미가 강하다 — 더 강한 신호가 순서와 무관하게 이겨야 정확한 개입 신호).
  it('같은 story에 needs_input이 먼저 도착해도 gate_pending이 뒤이어 오면 GATE로 승격된다(순서에 안 결박)', () => {
    const items = buildAttentionQueueFromBe([
      beItem({ kind: 'needs_input', story_id: 's1' }),
      beItem({ kind: 'gate_pending', story_id: 's1' }),
    ], t);
    expect(items).toHaveLength(1);
    expect(items[0]!.bucket).toBe('GATE');
  });
});

function inboxItem(overrides: Partial<import('./derive-attention-queue').InboxAttentionItem> = {}): import('./derive-attention-queue').InboxAttentionItem {
  return { id: 'inbox-1', kind: 'approval', title: '가격 콘솔 결재 요청', origin_chain: [], created_at: '2026-08-20T00:00:00.000Z', ...overrides };
}

describe('parseInboxAttentionItems (story #2923 AQ1 — /api/inbox {data:[...]} shape-safety)', () => {
  it('unwraps the {data:[...]} envelope', () => {
    const items = parseInboxAttentionItems({ data: [inboxItem()] });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('approval');
  });

  it('returns [] for malformed shapes (no-fiction)', () => {
    expect(parseInboxAttentionItems(null)).toEqual([]);
    expect(parseInboxAttentionItems({ foo: 'bar' })).toEqual([]);
    expect(parseInboxAttentionItems('not an object')).toEqual([]);
  });

  it('skips unknown kinds without crashing', () => {
    const items = parseInboxAttentionItems({ data: [inboxItem(), { id: 'x', kind: 'scope_violation', title: 't', origin_chain: [], created_at: '2026-01-01' }] });
    expect(items).toHaveLength(1);
  });

  it('skips items missing id/title/created_at (cannot fabricate claim/sort key)', () => {
    const items = parseInboxAttentionItems({
      data: [
        { kind: 'approval', title: 't', origin_chain: [], created_at: '2026-01-01' }, // no id
        { id: 'x', kind: 'approval', origin_chain: [], created_at: '2026-01-01' }, // no title
        { id: 'x', kind: 'approval', title: 't', origin_chain: [] }, // no created_at
      ],
    });
    expect(items).toEqual([]);
  });

  it('drops malformed origin_chain nodes but keeps well-formed ones', () => {
    const items = parseInboxAttentionItems({
      data: [inboxItem({ origin_chain: [{ type: 'story', id: 's1' }, { type: 'unknown_type', id: 'x' }, { type: 'memo' }] as never })],
    });
    expect(items[0]!.origin_chain).toEqual([{ type: 'story', id: 's1' }]);
  });
});

describe('resolveInboxItemHref (story #2923 AQ1 — PO 실측 라우트 우선순위: story > memo(slug 있으면) > null)', () => {
  it('story가 있으면 항상 그것을 쓴다(기존 /board?story= 관례)', () => {
    const href = resolveInboxItemHref([{ type: 'memo', id: 'm1' }, { type: 'story', id: 's1' }], new Map([['m1', 'my-doc']]));
    expect(href).toBe('/board?story=s1');
  });

  it('story 없고 memo만 있으면 사전 해소된 slug로 /docs/{slug}를 만든다', () => {
    const href = resolveInboxItemHref([{ type: 'memo', id: 'm1' }], new Map([['m1', 'my-doc']]));
    expect(href).toBe('/docs/my-doc');
  });

  it('memo인데 slug가 해소 안 됐으면(맵에 없음) null(지어내지 않음)', () => {
    const href = resolveInboxItemHref([{ type: 'memo', id: 'm1' }], new Map());
    expect(href).toBeNull();
  });

  it('run/initiative만 있으면(story/memo 둘 다 없음) null — FE 상세 라우트가 실재하지 않는다(PO 실측)', () => {
    expect(resolveInboxItemHref([{ type: 'run', id: 'r1' }], new Map())).toBeNull();
    expect(resolveInboxItemHref([{ type: 'initiative', id: 'i1' }], new Map())).toBeNull();
  });

  it('origin_chain이 비어 있으면 null', () => {
    expect(resolveInboxItemHref([], new Map())).toBeNull();
  });
});

describe('buildAttentionQueueFromInbox (story #2923 AQ1 — DecisionsWaiting 흡수)', () => {
  it('approval → GATE 버킷·결재 액션·amber', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ kind: 'approval' })], t, new Map());
    expect(item!.bucket).toBe('GATE');
    expect(item!.actionLabel).toBe('결재');
    expect(item!.proofState).toBe('amber');
    expect(item!.actionTone).toBe('primary');
  });

  it('decision → STEER 버킷·확認 액션', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ kind: 'decision' })], t, new Map());
    expect(item!.bucket).toBe('STEER');
    expect(item!.actionLabel).toBe('확認');
  });

  it('blocker → BLOCK 버킷·해소 액션', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ kind: 'blocker' })], t, new Map());
    expect(item!.bucket).toBe('BLOCK');
    expect(item!.actionLabel).toBe('해소');
    expect(item!.actionTone).toBe('neutral');
  });

  it('mention → Q 버킷·답 액션', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ kind: 'mention' })], t, new Map());
    expect(item!.bucket).toBe('Q');
    expect(item!.actionLabel).toBe('답');
  });

  it('claim은 item.title 그대로 쓴다(BE가 이미 완결된 문자열이라 템플릿 래핑 없음)', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ title: '가격 콘솔 결재 요청' })], t, new Map());
    expect(item!.claim).toBe('가격 콘솔 결재 요청');
  });

  it('href는 resolveInboxItemHref 그대로 반영한다(story 있으면 그걸로)', () => {
    const [item] = buildAttentionQueueFromInbox(
      [inboxItem({ origin_chain: [{ type: 'story', id: 's1' }] })], t, new Map(),
    );
    expect(item!.href).toBe('/board?story=s1');
  });

  it('run만 있어 라우트가 없으면 href=null(호출부가 비내비게이션 처리)', () => {
    const [item] = buildAttentionQueueFromInbox(
      [inboxItem({ origin_chain: [{ type: 'run', id: 'r1' }] })], t, new Map(),
    );
    expect(item!.href).toBeNull();
  });

  it('id에 inbox- 접두어를 붙여 BE 신호 id와 네임스페이스 충돌을 막는다', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ id: 'abc123' })], t, new Map());
    expect(item!.id).toBe('inbox-abc123');
  });

  it('ko/en 파리티 — en translator로도 렌더된다', () => {
    const [item] = buildAttentionQueueFromInbox([inboxItem({ kind: 'approval' })], tEn, new Map());
    expect(item!.actionLabel).toBe('Approve');
    expect(item!.kindLabel).toBe('Approval needed');
  });
});
