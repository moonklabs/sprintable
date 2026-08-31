// story #3194 — 미연결 에이전트 참가자 판별의 pin. 무거운 ChatView 전체 마운트 없이(use-
// reading-panel-stack.test.tsx와 동형 관례) 추출된 순수함수만 직접 잰다.
import { describe, expect, it } from 'vitest';
import { filterUnconnectedAgentParticipants } from './chat-view';

const ME = 'me-1';

describe('filterUnconnectedAgentParticipants', () => {
  it('verified===false인 에이전트 참가자(본인 제외)만 남긴다', () => {
    const result = filterUnconnectedAgentParticipants(
      [
        { member_id: ME, name: '나', type: 'human', verified: null },
        { member_id: 'agent-1', name: '올리베이라', type: 'agent', verified: false },
        { member_id: 'human-1', name: '동료', type: 'human', verified: null },
      ],
      ME,
    );
    expect(result.map((p) => p.member_id)).toEqual(['agent-1']);
  });

  it('verified===true(연결됨)인 에이전트는 제외된다 — AC2(연결되면 자연 소멸)의 근거', () => {
    const result = filterUnconnectedAgentParticipants(
      [{ member_id: 'agent-1', name: '올리베이라', type: 'agent', verified: true }],
      ME,
    );
    expect(result).toEqual([]);
  });

  it('verified가 undefined/null(판별 불가)이면 제외된다 — 침묵 실패보다 과소표시가 안전한 방향', () => {
    const undef = filterUnconnectedAgentParticipants(
      [{ member_id: 'agent-1', name: '올리베이라', type: 'agent' }],
      ME,
    );
    const nullish = filterUnconnectedAgentParticipants(
      [{ member_id: 'agent-1', name: '올리베이라', type: 'agent', verified: null }],
      ME,
    );
    expect(undef).toEqual([]);
    expect(nullish).toEqual([]);
  });

  it('human 참가자는 verified===false여도(방어적 입력) 대상이 아니다 — type 가드', () => {
    const result = filterUnconnectedAgentParticipants(
      [{ member_id: 'human-1', name: '동료', type: 'human', verified: false }],
      ME,
    );
    expect(result).toEqual([]);
  });

  it('본인은 verified===false여도 제외된다(자기 자신 배너 방지)', () => {
    const result = filterUnconnectedAgentParticipants(
      [{ member_id: ME, name: '나', type: 'agent', verified: false }],
      ME,
    );
    expect(result).toEqual([]);
  });

  it('group 대화 — 미연결 에이전트 다수를 전부 반환한다(배너의 count 문구가 소비)', () => {
    const result = filterUnconnectedAgentParticipants(
      [
        { member_id: 'agent-1', name: 'A', type: 'agent', verified: false },
        { member_id: 'agent-2', name: 'B', type: 'agent', verified: false },
        { member_id: 'agent-3', name: 'C', type: 'agent', verified: true },
      ],
      ME,
    );
    expect(result.map((p) => p.member_id)).toEqual(['agent-1', 'agent-2']);
  });

  it('participants가 undefined면 빈 배열(graceful)', () => {
    expect(filterUnconnectedAgentParticipants(undefined, ME)).toEqual([]);
  });
});
