import { describe, expect, it } from 'vitest';
import { synthesizeGateAction, type HeroActionLabels, type HeroGateEnvelope } from './derive-hero-envelope';

const LABELS: HeroActionLabels = { merge: '병합 검토', decide: '방향 결정', review: '검토 승인' };

describe('synthesizeGateAction — FE 라벨 합성(인간 결정 필요 gate에만·gate_type 분기)', () => {
  const gate = (over: Partial<HeroGateEnvelope>): HeroGateEnvelope => ({
    gate_type: 'merge', requires_human: true, ...over,
  });

  it('returns null for null gate or auto (requires_human=false) gate — no fabricated action', () => {
    expect(synthesizeGateAction(null, LABELS)).toBeNull();
    expect(synthesizeGateAction(gate({ requires_human: false }), LABELS)).toBeNull();
  });

  it('maps gate_type to the right label and links to the gate approval surface', () => {
    expect(synthesizeGateAction(gate({ gate_type: 'merge' }), LABELS)).toEqual({ action: '병합 검토', href: '/inbox?tab=gates' });
    expect(synthesizeGateAction(gate({ gate_type: 'loop_decision' }), LABELS)!.action).toBe('방향 결정');
    expect(synthesizeGateAction(gate({ gate_type: 'doc' }), LABELS)!.action).toBe('검토 승인');
  });
});
