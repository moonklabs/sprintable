import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  parseAttentionQueueSignals, buildAttentionQueueFromBe, buildAttentionQueue, diffAttentionQueueItemIds,
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
  return { kind: 'verify_fail', story_id: 'story-1', title: '결제 복구 플로우', ref: {}, ...overrides };
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
});

describe('buildAttentionQueue', () => {
  function item(kind: AttentionQueueItem['kind'], sortKey: number): AttentionQueueItem {
    return {
      id: `${kind}-${sortKey}`, kind, kindLabel: kind, proofState: kind === 'merge_ready' ? 'green' : 'amber',
      claim: kind, actor: null, actionLabel: '가기', actionTone: 'neutral', href: '/board', sortKey,
    };
  }

  it('sorts amber-tier items before merge_ready (green), most-recent-first within a tier', () => {
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
      id, kind: 'blocked', kindLabel: '막힘', proofState: 'amber', claim,
      actor: null, actionLabel: '조율', actionTone: 'neutral', href: '/board', sortKey: 0,
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
