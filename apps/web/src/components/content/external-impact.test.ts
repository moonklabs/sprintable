import { describe, expect, it } from 'vitest';
import { describeExternalImpact } from './external-impact';

// story #3402 AC11 — doc §5 각주 진리표. null을 "모름"이 아니라 "HTTP 실패가 없었다"로
// 읽는다(§5-1 근거) — 402/409/422/429는 관문에서 멈춘 것(그 관문 자체가 로컬 검증이든
// 서버 4xx든 Threads엔 안 나갔다), 502만 provider에 실제로 도달한 뒤 실패한 것이다.
describe('describeExternalImpact', () => {
  it.each([
    [502, 'reached_provider'],
    [409, 'not_sent'],
    [403, 'not_sent'],
    [422, 'not_sent'],
    [429, 'not_sent'],
    [null, 'not_sent'],
    [undefined, 'not_sent'],
  ] as const)('httpStatus=%s → %s', (httpStatus, expected) => {
    expect(describeExternalImpact(httpStatus)).toBe(expected);
  });
});
