import { describe, expect, it } from 'vitest';
import {
  parseHeroEnvelope,
  synthesizeGateAction,
  type HeroActionLabels,
  type HeroGateEnvelope,
} from './derive-hero-envelope';

const LABELS: HeroActionLabels = { merge: '병합 검토', decide: '방향 결정', review: '검토 승인' };

/** 실 BE payload를 프록시(apiSuccess)가 감싼 형태 = `{data:{…}}`. */
function proxied(body: unknown): unknown {
  return { data: body, error: null, meta: null };
}

const FULL = {
  story_id: 's1',
  claim: '결제 위젯 재설계',
  status: 'in-review',
  proof_count: 3,
  auto_verify: 'passed',
  gate: { status: 'pending', gate_type: 'merge', requires_human: true, decision_basis: 'ci_pass', auto_decision_reason: null },
  trust: {
    self_reported: true,
    human_verified: true,
    human_verified_by: { member_id: 'm1', name: '유나 홀름', role: 'admin' },
    human_verified_at: '2026-07-12T10:00:00Z',
  },
};

describe('parseHeroEnvelope — AC1 shape-safety (이중 엔벨로프 방어·형상 붕괴=null 폴백)', () => {
  it('unwraps the proxy envelope {data:{…}} into a typed HeroEnvelope', () => {
    const env = parseHeroEnvelope(proxied(FULL));
    expect(env).not.toBeNull();
    expect(env!.claim).toBe('결제 위젯 재설계');
    expect(env!.status).toBe('in-review');
    expect(env!.proof_count).toBe(3);
    expect(env!.auto_verify).toBe('passed');
    expect(env!.gate?.gate_type).toBe('merge');
    expect(env!.trust.human_verified_by?.name).toBe('유나 홀름');
  });

  it('also accepts the raw BE envelope (프록시 미경유 방어)', () => {
    const env = parseHeroEnvelope(FULL);
    expect(env!.claim).toBe('결제 위젯 재설계');
  });

  it('returns null (minimal-render fallback) — not throw — on shape collapse', () => {
    expect(parseHeroEnvelope(null)).toBeNull();
    expect(parseHeroEnvelope(undefined)).toBeNull();
    expect(parseHeroEnvelope('nope')).toBeNull();
    expect(parseHeroEnvelope([])).toBeNull();
    expect(parseHeroEnvelope(proxied({}))).toBeNull(); // claim/status 없음
    expect(parseHeroEnvelope(proxied({ claim: 'x' }))).toBeNull(); // status 없음
    expect(() => parseHeroEnvelope(proxied({ claim: 5, status: 7 }))).not.toThrow();
    expect(parseHeroEnvelope(proxied({ claim: 5, status: 7 }))).toBeNull();
  });

  it('coerces proof_count and auto_verify defensively (unknown values → safe defaults)', () => {
    const env = parseHeroEnvelope(proxied({
      claim: 'c', status: 'in-progress', proof_count: 'not-a-number', auto_verify: 'weird',
    }));
    expect(env!.proof_count).toBe(0);
    expect(env!.auto_verify).toBeNull();
  });

  it('tolerates a missing/broken gate and trust (renders what exists, no fiction)', () => {
    const env = parseHeroEnvelope(proxied({ claim: 'c', status: 'done', proof_count: 0 }));
    expect(env!.gate).toBeNull();
    expect(env!.trust).toEqual({ self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null });
  });

  it('drops a structurally-broken gate (no status/gate_type) rather than rendering a hollow one', () => {
    const env = parseHeroEnvelope(proxied({ claim: 'c', status: 'in-review', proof_count: 1, gate: { requires_human: true } }));
    expect(env!.gate).toBeNull();
  });

  it('drops human_verified_by when member fields are missing (no fabricated name)', () => {
    const env = parseHeroEnvelope(proxied({
      claim: 'c', status: 'done', proof_count: 2,
      trust: { self_reported: true, human_verified: true, human_verified_by: { member_id: 'm1' }, human_verified_at: null },
    }));
    expect(env!.trust.human_verified).toBe(true);
    expect(env!.trust.human_verified_by).toBeNull();
  });
});

describe('synthesizeGateAction — FE 라벨 합성(인간 결정 필요 gate에만·gate_type 분기)', () => {
  const gate = (over: Partial<HeroGateEnvelope>): HeroGateEnvelope => ({
    status: 'pending', gate_type: 'merge', requires_human: true, decision_basis: null, auto_decision_reason: null, ...over,
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
