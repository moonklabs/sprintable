// story #2888(S2a) — EmbedRenderer 결정 트리 SSOT. chat-bubble.tsx의 `p`(sole-link)·`a`(inline)
// 두 슬롯이 각자 인라인으로 짜던 asset/유령/referenceMeta 판정이 이 함수 하나로 수렴했다는
// 회귀가드 — 결정 트리 케이스별(AC2 "케이스별 회귀 테스트").
import { describe, expect, it } from 'vitest';
import { isGhostReference, findReferenceMeta, resolveEmbedDecision } from './embed-renderer';

const STORY_ID = '12345678-90ab-cdef-1234-567890abcdef';
const refs = [{ target_type: 'story', target_id: STORY_ID, form: 'mention', referenced_at: '2026-08-01T00:00:00Z' }];

describe('isGhostReference (story #2888)', () => {
  it('references가 undefined면 유령 아님(판단 재료 없음 — 폴백)', () => {
    expect(isGhostReference(undefined, 'story', STORY_ID)).toBe(false);
  });
  it('references가 []이고 매칭 없으면 유령', () => {
    expect(isGhostReference([], 'story', STORY_ID)).toBe(true);
  });
  it('references에 매칭 있으면 유령 아님(대소문자 무관)', () => {
    expect(isGhostReference(refs, 'STORY', STORY_ID.toUpperCase())).toBe(false);
  });
});

describe('findReferenceMeta (story #2888)', () => {
  it('매칭되면 form·referencedAt을 반환한다', () => {
    expect(findReferenceMeta(refs, 'story', STORY_ID)).toEqual({ form: 'mention', referencedAt: '2026-08-01T00:00:00Z' });
  });
  it('매칭 없으면 null', () => {
    expect(findReferenceMeta(refs, 'doc', STORY_ID)).toBeNull();
  });
  it('references가 undefined면 null', () => {
    expect(findReferenceMeta(undefined, 'story', STORY_ID)).toBeNull();
  });
});

describe('resolveEmbedDecision (story #2888) — 결정 트리', () => {
  it('asset은 allowCard 무관 항상 kind=asset', () => {
    expect(resolveEmbedDecision('asset', STORY_ID, refs, { allowCard: true })).toEqual({ kind: 'asset' });
    expect(resolveEmbedDecision('asset', STORY_ID, undefined, { allowCard: false })).toEqual({ kind: 'asset' });
  });

  it('sole-link(allowCard:true) + 비유령 → kind=card', () => {
    expect(resolveEmbedDecision('story', STORY_ID, refs, { allowCard: true })).toEqual({ kind: 'card' });
  });

  it('sole-link(allowCard:true)이어도 유령이면 card 아님 — chip(ghost:true)로 떨어진다', () => {
    const decision = resolveEmbedDecision('story', STORY_ID, [], { allowCard: true });
    expect(decision).toEqual({ kind: 'chip', ghost: true, referenceMeta: null });
  });

  it('allowCard:false면 비유령이어도 chip(ghost:false)', () => {
    const decision = resolveEmbedDecision('story', STORY_ID, refs, { allowCard: false });
    expect(decision).toEqual({ kind: 'chip', ghost: false, referenceMeta: { form: 'mention', referencedAt: '2026-08-01T00:00:00Z' } });
  });

  it('references undefined + allowCard:false → chip(ghost:false, referenceMeta:null) — mdBody/doc-content-renderer의 무-사이드밴드 케이스', () => {
    const decision = resolveEmbedDecision('story', STORY_ID, undefined, { allowCard: false });
    expect(decision).toEqual({ kind: 'chip', ghost: false, referenceMeta: null });
  });
});
