import { describe, expect, it } from 'vitest';
import { gateApproverLabel, GATE_APPROVER_LABEL_KEYS } from './gate-approver-label';

const t = (key: string) => {
  const table: Record<string, string> = {
    recipeGateApproverOrgOwner: '조직 소유자',
    recipeGateApproverUnknown: '승인자 미지정',
  };
  return table[key] ?? `⟨missing: ${key}⟩`;
};

describe('gateApproverLabel — story #4087 AC1/AC2', () => {
  it('org_owner → 조직 소유자', () => {
    expect(gateApproverLabel(t, 'org_owner')).toBe('조직 소유자');
  });

  it('미등재 키 → 중립 문구(raw 값 노출 0)', () => {
    expect(gateApproverLabel(t, 'some_future_unmapped_key')).toBe('승인자 미지정');
    expect(gateApproverLabel(t, 'some_future_unmapped_key')).not.toContain('some_future_unmapped_key');
  });

  it('null/undefined → 중립 문구(원래 approver 필드 자체가 없는 경우도 raw 노출 0으로 동일 취급)', () => {
    expect(gateApproverLabel(t, null)).toBe('승인자 미지정');
    expect(gateApproverLabel(t, undefined)).toBe('승인자 미지정');
  });

  it('policyApproverName이 있으면(story #4083 착지 후 정책값) 구조적 라벨보다 우선한다', () => {
    expect(gateApproverLabel(t, 'org_owner', '윤재')).toBe('윤재');
  });

  it('policyApproverName이 빈 문자열/null이면 무시하고 구조적 라벨로 폴백(?? 함정 방지)', () => {
    expect(gateApproverLabel(t, 'org_owner', null)).toBe('조직 소유자');
    expect(gateApproverLabel(t, 'org_owner', '')).toBe('조직 소유자');
  });

  it('레지스트리는 org_owner 1건 — 새 approver 키 추가 시 이 테이블부터 늘린다', () => {
    expect(Object.keys(GATE_APPROVER_LABEL_KEYS)).toEqual(['org_owner']);
  });
});
