// story #2613(PR #2824 승계) — BE(PR #3096) 구조화 403 계약 파서·메시지 빌더 순수 로직 검증.
import { describe, expect, it } from 'vitest';
import { buildPolicyDeniedMessage, parseAgentMessagePolicyDenied } from './agent-message-policy-error';

describe('parseAgentMessagePolicyDenied', () => {
  it('allowlist_miss — agent_id·member_id 둘 다 있는 정상 계약을 파싱한다', () => {
    const body = { detail: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: 'x', details: { agent_id: 'a-1', member_id: 'm-1', reason: 'allowlist_miss' } } };
    expect(parseAgentMessagePolicyDenied(body)).toEqual({ agent_id: 'a-1', member_id: 'm-1', reason: 'allowlist_miss' });
  });

  it('created_by_none — member_id 없어도(agent_id만) 파싱된다', () => {
    const body = { detail: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: 'x', details: { agent_id: 'a-1', reason: 'created_by_none' } } };
    expect(parseAgentMessagePolicyDenied(body)).toEqual({ agent_id: 'a-1', member_id: undefined, reason: 'created_by_none' });
  });

  it('creator_not_participant도 파싱된다', () => {
    const body = { detail: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: 'x', details: { agent_id: 'a-1', reason: 'creator_not_participant' } } };
    expect(parseAgentMessagePolicyDenied(body)?.reason).toBe('creator_not_participant');
  });

  it('code가 다른 계약(예: invalid_payload)은 null — 다른 4xx와 안 섞인다', () => {
    const body = { detail: { code: 'invalid_payload', message: 'x', details: {} } };
    expect(parseAgentMessagePolicyDenied(body)).toBeNull();
  });

  it('reason이 화이트리스트 밖(미지 값)이면 null — 모르는 사유를 아는 척 안 한다', () => {
    const body = { detail: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: 'x', details: { agent_id: 'a-1', reason: 'some_future_reason' } } };
    expect(parseAgentMessagePolicyDenied(body)).toBeNull();
  });

  it('body가 null/문자열/detail 없음이면 전부 null(방어적)', () => {
    expect(parseAgentMessagePolicyDenied(null)).toBeNull();
    expect(parseAgentMessagePolicyDenied('plain string')).toBeNull();
    expect(parseAgentMessagePolicyDenied({})).toBeNull();
    expect(parseAgentMessagePolicyDenied({ detail: 'not an object' })).toBeNull();
    expect(parseAgentMessagePolicyDenied({ detail: { code: 'AGENT_MESSAGE_POLICY_DENIED' } })).toBeNull();
  });

  it('agent_id가 문자열이 아니면 null', () => {
    const body = { detail: { code: 'AGENT_MESSAGE_POLICY_DENIED', details: { agent_id: 123, reason: 'created_by_none' } } };
    expect(parseAgentMessagePolicyDenied(body)).toBeNull();
  });
});

describe('buildPolicyDeniedMessage', () => {
  const members = [{ id: 'a-1', name: '점검봇' }, { id: 'm-1', name: '유나' }];
  const t = (key: string, values?: Record<string, string>) => {
    const templates: Record<string, string> = {
      policyDeniedAllowlistMiss: '{member}님은 {agent}의 발신 허용 목록에 없습니다.',
      policyDeniedCreatedByNone: '{agent}에게 생성자가 설정돼 있지 않아 대화를 시작할 수 없습니다.',
      policyDeniedCreatorNotParticipant: '{agent}의 생성자가 이 대화에 참여하고 있지 않아 메시지를 보낼 수 없습니다.',
      policyDeniedUnknownAgent: '이 에이전트',
      policyDeniedUnknownMember: '이 멤버',
    };
    let out = templates[key] ?? key;
    for (const [k, v] of Object.entries(values ?? {})) out = out.replace(`{${k}}`, v);
    return out;
  };

  it('allowlist_miss — 에이전트·멤버 둘 다 이름으로 치환된다(AC2 핵심)', () => {
    const msg = buildPolicyDeniedMessage({ agent_id: 'a-1', member_id: 'm-1', reason: 'allowlist_miss' }, members, t);
    expect(msg).toBe('유나님은 점검봇의 발신 허용 목록에 없습니다.');
  });

  it('created_by_none — 에이전트 이름만 필요, member_id 없어도 안 깨진다', () => {
    const msg = buildPolicyDeniedMessage({ agent_id: 'a-1', reason: 'created_by_none' }, members, t);
    expect(msg).toBe('점검봇에게 생성자가 설정돼 있지 않아 대화를 시작할 수 없습니다.');
  });

  it('creator_not_participant — 에이전트 이름 치환', () => {
    const msg = buildPolicyDeniedMessage({ agent_id: 'a-1', reason: 'creator_not_participant' }, members, t);
    expect(msg).toBe('점검봇의 생성자가 이 대화에 참여하고 있지 않아 메시지를 보낼 수 없습니다.');
  });

  it('members 목록에 없는 id(경합·페이지네이션 누락)는 정직한 폴백 문구로 떨어진다(침묵 오렌더 금지)', () => {
    const msg = buildPolicyDeniedMessage({ agent_id: 'unknown-agent', member_id: 'unknown-member', reason: 'allowlist_miss' }, members, t);
    expect(msg).toBe('이 멤버님은 이 에이전트의 발신 허용 목록에 없습니다.');
  });
});
