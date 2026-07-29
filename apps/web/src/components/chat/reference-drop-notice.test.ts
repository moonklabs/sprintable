/**
 * story #2294 AC8/AC11 — 메시지 전송 응답 최상위(`data`의 형제, `conversations.py:2165`)의
 * `references.dropped[]`를 안전하게 뽑는 순수 함수. 정상 경로(AC1로 검색 허용목록이 registry와
 * 일치)에선 항상 빈 배열이어야 하고, 사람이 손으로 치거나 에이전트가 API로 직접 쓴 registry
 * 밖 토큰만 여기 걸린다(PO 실측, 2026-07-28 13:58Z 날것 `]` 토큰 사례).
 */
import { describe, expect, it } from 'vitest';
import { parseDroppedReferences } from './reference-drop-notice';

describe('parseDroppedReferences', () => {
  it('정상 경로(dropped 빈 배열)는 빈 배열을 그대로 반환한다', () => {
    expect(parseDroppedReferences({ data: {}, references: { stored: 2, dropped: [] } })).toEqual([]);
  });

  it('references 필드 자체가 없으면(구버전 응답·아직 안 붙은 프록시) 빈 배열로 폴백한다(throw 0)', () => {
    expect(parseDroppedReferences({ data: {} })).toEqual([]);
  });

  it('dropped 1건을 그대로 뽑는다', () => {
    const raw = { data: {}, references: { stored: 1, dropped: [{ target_type: 'task', target_id: 't1' }] } };
    expect(parseDroppedReferences(raw)).toEqual([{ target_type: 'task', target_id: 't1' }]);
  });

  it('⛔dropped가 data 안(형제 아닌 자식)에 있으면 못 찾는다 — sibling 자리를 정확히 읽는지 확인', () => {
    const raw = { data: { references: { dropped: [{ target_type: 'task', target_id: 't1' }] } } };
    expect(parseDroppedReferences(raw)).toEqual([]);
  });

  it('형상이 깨진 원소(target_type 누락 등)는 조용히 걸러낸다', () => {
    const raw = { references: { dropped: [{ target_type: 'task' }, { target_type: 'epic', target_id: 'e1' }] } };
    expect(parseDroppedReferences(raw)).toEqual([{ target_type: 'epic', target_id: 'e1' }]);
  });

  it('null/undefined/문자열 등 비-object 입력에도 throw 없이 빈 배열', () => {
    expect(parseDroppedReferences(null)).toEqual([]);
    expect(parseDroppedReferences(undefined)).toEqual([]);
    expect(parseDroppedReferences('garbage')).toEqual([]);
  });
});
