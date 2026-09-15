import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import type { useTranslations } from 'next-intl';
import { attentionEntityLabel, attentionDayCount, attentionDetailText } from './action-zone';
import type { AttentionItem } from './types';
import koMessagesRaw from '../../../../messages/ko.json';

// story #3918 — ActionZone(command-center) 컴포넌트·QueueRow·WaitingRow·AttentionRow가
// 삭제되며(실 소비처 0, /dashboard는 이미 /chats로 리다이렉트) 렌더 경유 검증(renderToStaticMarkup
// + <ActionZone>)이 더는 불가 — 남은 3개 순수 함수(attentionEntityLabel/attentionDayCount/
// attentionDetailText, chat 「지금」 스트립 derive-now-strip.ts가 그대로 재사용 中)를 직접
// 호출하는 형태로 재작성. story #3150의 "58건 공백 렌더" 회귀가드 취지는 그대로 보존한다.
type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
// next-intl의 Translator<M,N> 오버로드 집합이 이 LooseMessages 비-리터럴 import와 구조적으로
// 안 맞는 마찰(derive-attention-queue.test.ts와 동형) — 경계에서만 cast, 런타임 동작은 그대로.
const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'dashboard' }) as unknown as ReturnType<typeof useTranslations>;

// story #3150(시연 리허설 발견) — AttentionItem이 실제로는 (당시)8종인데 AttentionRow가
// 'agent_stuck' 전용 필드(entity_id/entity_type)만 읽어 나머지는 통째로 공백 렌더되던 것
// (58건 실측). 각 타입이 BE(#2538 계약)가 이미 싣는 title/statement/blocked_story_title을
// 그대로 보여주는지 회귀가드. ⛔story #3154 — 'story_stalled'는 BE가 완전 제거해(story
// #93b076c8, twin 신호 정리) 지금은 7종 → 6종 전수(이 describe 스코프)만 남았다.
describe('attentionEntityLabel/attentionDetailText — story #3150 6종 전수(BE title/statement 폴백 없이 직접 소비)', () => {
  it('unanswered_blocker — blocked_story_title+age_days를 그대로 보여준다', () => {
    const item: AttentionItem = { type: 'unanswered_blocker', severity: 'warn', auto_detected: true, blocked_story_id: 's2', blocker_id: 's3', blocked_story_title: '온보딩 완주 체크', age_days: 5, project_id: 'p1' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('온보딩 완주 체크');
    expect(attentionDetailText(t, item)).toContain('5일째');
  });

  it('hypothesis_falsified — statement를 그대로 보여준다(days 없으면 확인 필요 폴백)', () => {
    const item: AttentionItem = { type: 'hypothesis_falsified', severity: 'info', auto_detected: true, hypothesis_id: 'h1', statement: '위클리 다이제스트가 리텐션을 높인다', outcome_result: null, falsified_days: null, superseded_by_hypothesis_id: null, project_id: 'p1' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('위클리 다이제스트가 리텐션을 높인다');
    expect(attentionDetailText(t, item)).toContain('확인 필요');
  });

  it('loop_overdue_hypothesis — statement+overdue_days', () => {
    const item: AttentionItem = { type: 'loop_overdue_hypothesis', severity: 'warn', auto_detected: true, hypothesis_id: 'h2', statement: '리뷰 에이전트가 결함을 줄인다', owner_member_id: null, overdue_days: 3, project_id: 'p1' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('리뷰 에이전트가 결함을 줄인다');
    expect(attentionDetailText(t, item)).toContain('3일째');
  });

  it('loop_overdue_goal — title+overdue_days', () => {
    const item: AttentionItem = { type: 'loop_overdue_goal', severity: 'warn', auto_detected: true, goal_id: 'g1', title: '가입 전환율 개선', owner_member_id: null, overdue_days: 10, project_id: 'p1' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('가입 전환율 개선');
    expect(attentionDetailText(t, item)).toContain('10일째');
  });

  it('loop_outcome_missing_goal — title+done_days', () => {
    const item: AttentionItem = { type: 'loop_outcome_missing_goal', severity: 'warn', auto_detected: true, goal_id: 'g2', title: '온보딩 완주율', owner_member_id: null, done_days: 7, project_id: 'p1' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('온보딩 완주율');
    expect(attentionDetailText(t, item)).toContain('7일째');
  });

  it('agent_auth_failure — resolveName으로 멤버명 해소+실패 횟수', () => {
    const item: AttentionItem = { type: 'agent_auth_failure', severity: 'danger', auto_detected: true, member_id: 'm1', reason: 'expired', failure_count: 4, first_failed_at: '2026-08-27T00:00:00Z', last_failed_at: '2026-08-27T01:00:00Z' };
    expect(attentionEntityLabel(item, (id) => (id === 'm1' ? '까디르 아흐마디' : null), {})).toBe('까디르 아흐마디');
    expect(attentionDetailText(t, item)).toContain('인증 실패 4회');
  });

  it('agent_auth_failure — resolveName이 못 찾으면 reason으로 폴백(빈 값 아님)', () => {
    const item: AttentionItem = { type: 'agent_auth_failure', severity: 'danger', auto_detected: true, member_id: 'm-unknown', reason: 'revoked', failure_count: 1, first_failed_at: null, last_failed_at: null };
    expect(attentionEntityLabel(item, () => null, {})).toBe('revoked');
  });

  it('agent_stuck — resolveName 우선, 없으면 epicTitles, 그것도 없으면 entity_type', () => {
    const item: AttentionItem = { type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 's1', gate_type: 'qa', stuck_since: '2026-07-10T00:00:00Z' };
    expect(attentionEntityLabel(item, () => null, {})).toBe('story');
    expect(attentionEntityLabel(item, () => null, { s1: '에픽 제목' })).toBe('에픽 제목');
    expect(attentionEntityLabel(item, () => '멤버명', {})).toBe('멤버명');
    expect(attentionDetailText(t, item)).toContain('QA'); // gate_type='qa' → 번역 라벨(gateLabel), 원시값 안 보임(PO 지적 2026-07-29)
  });
});

describe('attentionDayCount — 5종만 「일수」가 있고 2종(agent_stuck/agent_auth_failure)은 null', () => {
  it('agent_stuck/agent_auth_failure는 날짜 개념이 없어 null', () => {
    expect(attentionDayCount({ type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 's1', gate_type: 'qa', stuck_since: '2026-07-10T00:00:00Z' })).toBeNull();
    expect(attentionDayCount({ type: 'agent_auth_failure', severity: 'danger', auto_detected: true, member_id: 'm1', reason: 'x', failure_count: 1, first_failed_at: null, last_failed_at: null })).toBeNull();
  });
});
