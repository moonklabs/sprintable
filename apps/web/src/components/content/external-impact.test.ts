import { describe, expect, it } from 'vitest';
import { describeExternalImpact } from './external-impact';
import type { SitePostApiErrorKind } from './api-error';

// story #3402 AC11 — 페드루 PO 블로커 판정(2026-09-04 06:17Z) 반영. 판정 축은 http_status
// 숫자가 아니라 오류 kind다(500/503/504·BFF 400·미지 코드는 kind='unknown'으로 이미
// fail-closed 되어 있으므로 여기서 목록을 따로 안 든다 — api-error.ts가 그 축의 정본).
describe('describeExternalImpact', () => {
  it.each([
    ['provider_error', 'reached_provider'],
    ['rate_limited', 'not_sent'],
    ['token_expired', 'not_sent'],
    ['connection_not_active', 'not_sent'],
    ['approver_role_missing', 'not_sent'],
    ['permission', 'not_sent'],
    ['publish_in_progress', 'not_sent'],
    ['text_too_long', 'not_sent'],
    ['approval_required', 'not_sent'],
    ['seal_missing', 'not_sent'],
    ['reapproval_required', 'not_sent'],
    ['resubmit_required', 'not_sent'],
    ['gate_already_held', 'not_sent'],
    // 🚨블로커 재현 — v1은 이 자리(매핑표에 없는 모든 것: 500/503/504·BFF 400·신규 미지
    // 코드가 실제로 떨어지는 자리)를 not_sent로 잘못 단정했다. "모른다"는 "안 나갔다"가
    // 아니다(§17-4) — fail-closed로 'unknown'을 내야 한다.
    ['unknown', 'unknown'],
  ] as const)('kind=%s → %s', (kind, expected) => {
    expect(describeExternalImpact(kind as SitePostApiErrorKind)).toBe(expected);
  });

  it('kind=undefined(호출 자체가 실패해 파싱 전) → unknown(모른다를 안 나갔다로 단정 안 함)', () => {
    expect(describeExternalImpact(undefined)).toBe('unknown');
  });
});
