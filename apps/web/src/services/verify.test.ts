import { describe, expect, it } from 'vitest';
import { deriveTrustStage } from './verify';

describe('deriveTrustStage (claimed-vs-verified-spec-handoff §3 파생 규칙)', () => {
  it('returns "verified" when human_verified is true (green 무결성 — human_verified가 유일한 green 조건)', () => {
    expect(deriveTrustStage({ human_verified: true, self_reported: true })).toBe('verified');
  });

  it('returns "claimed" when self_reported is true but human_verified is not', () => {
    expect(deriveTrustStage({ self_reported: true, human_verified: null })).toBe('claimed');
    expect(deriveTrustStage({ self_reported: true, human_verified: false })).toBe('claimed');
  });

  it('returns null (무표시) when self_reported is falsy — D-03 완료 기준(증거 없는 Done은 승격 불가)', () => {
    expect(deriveTrustStage({ self_reported: null, human_verified: null })).toBeNull();
    expect(deriveTrustStage({})).toBeNull();
  });

  it('never returns "claimed" when human_verified is true, even if self_reported is somehow false (verified takes precedence)', () => {
    expect(deriveTrustStage({ self_reported: false, human_verified: true })).toBe('verified');
  });
});
