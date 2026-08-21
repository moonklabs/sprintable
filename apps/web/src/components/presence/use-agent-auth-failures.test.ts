// story #2852(2836 FE 조각, BE PR#3266) — parseAgentAuthFailures 순수 파싱 검증. attention.
// items[]에서 type==='agent_auth_failure'만 골라 member_id 키 맵으로 접는지, reason이 화이트
// 리스트 밖이면(계약 위반) 조용히 지어내지 않고 생략하는지(no-fiction) 고정한다.
import { describe, expect, it } from 'vitest';
import { parseAgentAuthFailures } from './use-agent-auth-failures';

function payload(items: unknown[]) {
  return { data: { attention: { items } } };
}

describe('parseAgentAuthFailures', () => {
  it('agent_auth_failure 항목만 member_id 키 맵으로 뽑는다(다른 타입은 무시)', () => {
    const out = parseAgentAuthFailures(payload([
      { type: 'story_stalled', story_id: 's1' },
      { type: 'agent_auth_failure', member_id: 'm1', reason: 'expired', failure_count: 6 },
    ]));
    expect(Object.keys(out)).toEqual(['m1']);
    expect(out.m1).toEqual({ reason: 'expired', failureCount: 6 });
  });

  it('reason이 화이트리스트(expired/revoked/invalid) 밖이면 생략한다(no-fiction)', () => {
    const out = parseAgentAuthFailures(payload([
      { type: 'agent_auth_failure', member_id: 'm1', reason: 'unknown_reason', failure_count: 6 },
    ]));
    expect(out).toEqual({});
  });

  it('member_id가 없으면(귀속 불가) 맵에 못 올린다 — 뱃지는 member_id 키로만 매핑되므로', () => {
    const out = parseAgentAuthFailures(payload([
      { type: 'agent_auth_failure', member_id: null, reason: 'invalid', failure_count: 3 },
    ]));
    expect(out).toEqual({});
  });

  it('attention.items가 없거나 형상이 어긋나면 빈 맵을 낸다(throw 0)', () => {
    expect(parseAgentAuthFailures(null)).toEqual({});
    expect(parseAgentAuthFailures({})).toEqual({});
    expect(parseAgentAuthFailures(payload(null as unknown as unknown[]))).toEqual({});
  });
});
