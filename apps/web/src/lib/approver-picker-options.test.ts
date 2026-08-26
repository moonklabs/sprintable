// story #3040 v3(선생님 확定, 2026-08-25) — 동명 표시이름 오지정 실사고 재발 방지.
// buildApproverPickerOptions는 doc-gate-section.tsx·approval-request-card.tsx 두 지정
// 표면이 공유하는 단일 소스라, 이 파일 하나만 검증하면 두 픽커가 갈릴 위험이 없다.
import { describe, expect, it } from 'vitest';
import { buildApproverPickerOptions, type ApproverPickerMember } from './approver-picker-options';

function member(overrides: Partial<ApproverPickerMember>): ApproverPickerMember {
  return {
    id: 'm-default', user_id: 'u-default', name: 'Default', email: 'default@test.com', role: 'admin',
    ...overrides,
  };
}

describe('buildApproverPickerOptions', () => {
  it('AC1 — label은 항상 "이름 (이메일)" 병기다(이름만 렌더 금지)', () => {
    const { options } = buildApproverPickerOptions([
      member({ id: 'm-1', name: '송윤재', email: 'iamyoonjae@moonklabs.com' }),
    ]);
    expect(options).toEqual([{ value: 'm-1', label: '송윤재 (iamyoonjae@moonklabs.com)' }]);
  });

  it('story #3040 실사고 재현 — 동명 2계정(선생님 실계정 vs PO 대행 계정)이 이메일로 구별된다', () => {
    const { options, hasDuplicateNames } = buildApproverPickerOptions([
      member({ id: 'e75ca548', name: '송윤재', email: 'iamyoonjae@moonklabs.com' }),
      member({ id: '2fd14616', name: '송윤재', email: 'sellerking@moonklabs.com' }),
    ]);
    expect(hasDuplicateNames).toBe(true);
    expect(options).toEqual([
      { value: 'e75ca548', label: '송윤재 (iamyoonjae@moonklabs.com)' },
      { value: '2fd14616', label: '송윤재 (sellerking@moonklabs.com)' },
    ]);
  });

  it('AC2 음성대조 — 동명이 없는 org는 hasDuplicateNames=false', () => {
    const { hasDuplicateNames } = buildApproverPickerOptions([
      member({ id: 'm-1', name: 'Alice' }),
      member({ id: 'm-2', name: 'Bob' }),
    ]);
    expect(hasDuplicateNames).toBe(false);
  });

  it('이름 없으면 이메일만 label(지어내지 않음)', () => {
    const { options } = buildApproverPickerOptions([
      member({ id: 'm-1', name: null, email: 'noname@test.com' }),
    ]);
    expect(options).toEqual([{ value: 'm-1', label: 'noname@test.com' }]);
  });

  it('이름·이메일 둘 다 없으면 user_id 앞 8자로 후퇴(최후 fallback)', () => {
    const { options } = buildApproverPickerOptions([
      member({ id: 'm-1', name: null, email: null, user_id: 'abcdef1234567890' }),
    ]);
    expect(options).toEqual([{ value: 'm-1', label: 'abcdef12' }]);
  });

  it('role=member는 후보에서 제외된다(owner/admin만, 기존 규율 무변경)', () => {
    const { options } = buildApproverPickerOptions([
      member({ id: 'm-owner', role: 'owner' }),
      member({ id: 'm-member', role: 'member' }),
    ]);
    expect(options.map((o) => o.value)).toEqual(['m-owner']);
  });

  it('excludeId(본인)는 후보에서 제외된다(기존 규율 무변경)', () => {
    const { options } = buildApproverPickerOptions(
      [member({ id: 'm-1' }), member({ id: 'm-2' })],
      'm-1',
    );
    expect(options.map((o) => o.value)).toEqual(['m-2']);
  });

  it('중복 이름 판정은 owner/admin·본인 제외 후보군 기준이다(제외된 사람은 안 셈)', () => {
    const { hasDuplicateNames } = buildApproverPickerOptions(
      [
        member({ id: 'm-1', name: '송윤재', role: 'owner' }),
        member({ id: 'm-2', name: '송윤재', role: 'member' }), // role=member라 후보 제외 → 동명 카운트 무관
      ],
    );
    expect(hasDuplicateNames).toBe(false);
  });
});
