// story #4281 — 사람에게 가는 dispatched 알림의 종류 키 · 원문 시간을 표시 시점에 사람 낱말로(유나 확정 문안). 저장된 문자열(옛 행
// 포함)을 그대로 받아 바꾸므로 BE 출처 모양(`agent_dispatch.py` 제목 · `l2_heuristics.py` · `l2_trigger_worker.py` 사유)과 짝을 이룬다.
// 뮤테이션: 모양 하나의 정규식을 깨면 그 경우가 원문 그대로 남아 RED.
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import enMessages from '../../../../messages/en.json';
import { composeDispatchedHeuristicDisplay, humanizeHours } from './inbox-notification-display';

const tKo = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'inbox' }) as unknown as (k: string, v?: Record<string, string | number>) => string;
const tEn = createTranslator({ locale: 'en', messages: enMessages, namespace: 'inbox' }) as unknown as (k: string, v?: Record<string, string | number>) => string;

describe('dispatched 알림 표시(story #4281 · 유나 문안)', () => {
  it('제목은 앞 [종류]만 뗀다', () => {
    expect(composeDispatchedHeuristicDisplay('[hypothesis] 리뷰 에이전트를 붙이면 결함이 준다', null, tKo).title)
      .toBe('리뷰 에이전트를 붙이면 결함이 준다');
  });

  it.each([
    ['hypothesis 마감이 743h 초과됨', '가설 마감이 31일 지났어요.', 'Hypothesis deadline passed 31 days ago.'],
    ['sprint 마감이 5h 초과됨', '스프린트 마감이 5시간 지났어요.', 'Sprint deadline passed 5 hours ago.'],
    ['epic 마감까지 30h 남음(임계 72h)', '목표 마감까지 30시간 남았어요.', 'Goal deadline in 30 hours.'],
    ['sprint 마감까지 0h 남음(임계 72h)', '스프린트 마감까지 1시간 미만 남았어요.', 'Sprint deadline in less than an hour.'],
    ['story/in-review 96h 무활동(임계 48h)', '4일째 활동이 없어요(스토리 · 리뷰 중).', 'No activity for 4 days (Story · In Review).'],
    ['sprint 120h 무활동(임계 72h)', '5일째 활동이 없어요(스프린트).', 'No activity for 5 days (Sprint).'],
    ['story 상태 변경 → in-review', '스토리 상태가 바뀌었어요: 리뷰 중.', 'Story status changed: In Review.'],
    ['story 상태 변경 → some-new-slug', '스토리 상태가 바뀌었어요.', 'Story status changed.'],
    ['epic 상태 변경', '목표 상태가 바뀌었어요.', 'Goal status changed.'],
  ])('본문 «%s»', (body, ko, en) => {
    expect(composeDispatchedHeuristicDisplay('[story] S', body, tKo).body).toBe(ko);
    expect(composeDispatchedHeuristicDisplay('[story] S', body, tEn).body).toBe(en);
  });

  it('모양을 못 알아보면(사람이 쓴 dispatch 메시지 등) 원문 그대로 · 내부 키 · «h 초과» 0', () => {
    expect(composeDispatchedHeuristicDisplay('수동 제목', '리뷰 부탁드려요', tKo)).toEqual({ title: '수동 제목', body: '리뷰 부탁드려요' });
  });

  it('기간: 1시간 미만 · 48시간 미만 시간 · 이상 일(반올림)', () => {
    expect(humanizeHours(0, tKo)).toBe('1시간 미만');
    expect(humanizeHours(47, tKo)).toBe('47시간');
    expect(humanizeHours(48, tKo)).toBe('2일');
    expect(humanizeHours(1, tEn)).toBe('1 hour');
    expect(humanizeHours(24 * 31, tEn)).toBe('31 days');
  });
});
