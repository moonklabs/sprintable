import { describe, expect, it } from 'vitest';
import { deriveNeedsMeState, hrefForNeedsMeItem, parseToday } from './derive-today';

describe('deriveNeedsMeState — 낱말 표 §① 상태 3어(PO 確定 2026-09-13 09:43Z)', () => {
  it('kind=answer → answer(다른 값 무관)', () => {
    expect(deriveNeedsMeState('answer', 'low')).toBe('answer');
    expect(deriveNeedsMeState('answer', 'high')).toBe('answer');
  });

  it('kind=signature → signature(risk 무관)', () => {
    expect(deriveNeedsMeState('signature', 'low')).toBe('signature');
    expect(deriveNeedsMeState('signature', 'high')).toBe('signature');
  });

  it('kind=approval && risk=high → signature(돈·외부 발송 구분은 pill 밖)', () => {
    expect(deriveNeedsMeState('approval', 'high')).toBe('signature');
  });

  it('kind=approval && risk=low → approval', () => {
    expect(deriveNeedsMeState('approval', 'low')).toBe('approval');
  });
});

describe('hrefForNeedsMeItem — 기존 라우트 재사용(새 API 0)', () => {
  it('source=gate → /gates/{id}(canonical 상세)', () => {
    expect(hrefForNeedsMeItem({ source: 'gate', id: 'g1' })).toBe('/gates/g1');
  });

  it('source=hitl → /inbox?tab=gates(전용 상세 없음)', () => {
    expect(hrefForNeedsMeItem({ source: 'hitl', id: 'h1' })).toBe('/inbox?tab=gates');
  });

  it('source=workflow_step → /inbox?tab=gates(전용 상세 없음)', () => {
    expect(hrefForNeedsMeItem({ source: 'workflow_step', id: 'w1' })).toBe('/inbox?tab=gates');
  });
});

describe('parseToday — story #3823 실 응답 모양 파싱(no-fiction)', () => {
  it('전체 4구역을 정확히 파싱한다', () => {
    const raw = {
      needs_me: [
        {
          kind: 'signature', risk: 'high', source: 'gate', source_id: 'g1',
          work_item: { type: 'story', id: 's1', title: 'Threads에 글 발행' },
          requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
        },
        {
          kind: 'answer', risk: 'low', source: 'hitl', source_id: 'h1',
          work_item: { type: 'story', id: 's2', title: '' },
          requested_by: null, reason: 'YouTube 챕터를 3개로 나눌까요?', created_at: '2026-09-13T04:00:00Z', actions: ['answer'],
        },
      ],
      needs_me_count: 2,
      agent_progress: [
        {
          run_id: 'r1', agent: { id: 'a1', name: '미르코' },
          work_item: { type: 'story', id: 's3', title: 'YouTube 영상 올리기' },
          status: 'running', current_step: null, started_at: '2026-09-13T03:00:00Z',
        },
      ],
      published_today: { count: 3, by_channel: [{ channel_kind: 'blog', count: 2 }, { channel_kind: 'newsletter', count: 1 }], since: '2026-09-13T00:00:00Z' },
      usage: { platform: [{ connection_id: 'c1', channel_kind: 'youtube', used: 100, limit: 10000, reset_at: '2026-09-14T00:00:00Z' }], ad_spend: { measured: false } },
    };
    const snapshot = parseToday({ data: raw });
    expect(snapshot.needsMeCount).toBe(2);
    expect(snapshot.needsMe).toHaveLength(2);
    expect(snapshot.needsMe[0]).toEqual({
      id: 'g1', source: 'gate', state: 'signature', workItemType: 'story', workItemId: 's1',
      workItemTitle: 'Threads에 글 발행', requestedByName: null, reason: null,
      createdAt: '2026-09-13T05:00:00Z', conversationId: null,
    });
    expect(snapshot.needsMe[1]!.state).toBe('answer');
    expect(snapshot.needsMe[1]!.reason).toBe('YouTube 챕터를 3개로 나눌까요?');
    expect(snapshot.agentProgress).toHaveLength(1);
    expect(snapshot.agentProgress[0]).toEqual({
      runId: 'r1', agentName: '미르코', workItemTitle: 'YouTube 영상 올리기', status: 'running', startedAt: '2026-09-13T03:00:00Z',
    });
    expect(snapshot.published).toEqual({ count: 3, byChannel: [{ channelKind: 'blog', count: 2 }, { channelKind: 'newsletter', count: 1 }] });
    expect(snapshot.usage).toEqual({ platform: [{ connectionId: 'c1', channelKind: 'youtube', used: 100, limit: 10000, resetAt: '2026-09-14T00:00:00Z' }], adSpendMeasured: false });
  });

  it('conversation_id가 없으면(BE가 비참여 실행에 null 반환하는 경우) null로 파싱한다 — 링크 0 경로', () => {
    const raw = {
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: '블로그 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }],
      needs_me_count: 1, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
    };
    expect(parseToday({ data: raw }).needsMe[0]!.conversationId).toBeNull();
  });

  it('conversation_id가 있으면(story #3828, 캐폴러가 실참여자인 실행) 그대로 잡는다', () => {
    const raw = {
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: '블로그 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
        conversation_id: 'conv-1',
      }],
      needs_me_count: 1, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
    };
    expect(parseToday({ data: raw }).needsMe[0]!.conversationId).toBe('conv-1');
  });

  it('핵심 식별자(work_item.id·created_at) 없는 needs_me 항목은 생략한다(지어내지 않음)', () => {
    const raw = {
      needs_me: [{ kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1', work_item: null, created_at: null }],
      needs_me_count: 1, agent_progress: [], published_today: {}, usage: {},
    };
    expect(parseToday({ data: raw }).needsMe).toEqual([]);
  });

  it('source가 알 수 없는 값이면 항목을 생략한다(raw enum 유출 금지)', () => {
    const raw = {
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'unknown_source', source_id: 'x1',
        work_item: { type: 'story', id: 's1', title: 't' }, created_at: '2026-09-13T05:00:00Z',
      }],
      needs_me_count: 1, agent_progress: [], published_today: {}, usage: {},
    };
    expect(parseToday({ data: raw }).needsMe).toEqual([]);
  });

  it('빈 응답은 EMPTY 스냅샷과 동형이다', () => {
    const empty = parseToday({ data: { needs_me: [], needs_me_count: 0, agent_progress: [], published_today: {}, usage: {} } });
    expect(empty.needsMe).toEqual([]);
    expect(empty.agentProgress).toEqual([]);
    expect(empty.published).toEqual({ count: 0, byChannel: [] });
    expect(empty.usage).toEqual({ platform: [], adSpendMeasured: false });
  });

  it('완전히 형상이 어긋난 값(null·배열)이 와도 throw 없이 EMPTY로 폴백한다', () => {
    expect(parseToday(null)).toEqual({ needsMe: [], needsMeCount: 0, agentProgress: [], published: { count: 0, byChannel: [] }, usage: { platform: [], adSpendMeasured: false } });
    expect(parseToday([1, 2, 3])).toEqual({ needsMe: [], needsMeCount: 0, agentProgress: [], published: { count: 0, byChannel: [] }, usage: { platform: [], adSpendMeasured: false } });
  });
});
