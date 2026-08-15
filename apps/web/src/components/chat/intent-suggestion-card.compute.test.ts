import { describe, it, expect } from 'vitest';
import { computeSuggestion } from './intent-suggestion-card';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';

const DOC_ID = 'aabbccdd-1111-1111-1111-111111111111';
const STORY_ID = '22222222-2222-2222-2222-222222222222';
// PO 라이브 판정 RED(2026-08-15) — "심은 표본엔 아는 종류만" 교훈. 공용 헬퍼부터 실 정본
// 이스케이프 토큰(제목에 대괄호 든 QA 폐기용 문서류·reference_token.py:_escape_title 산출물)
// 으로 바꿔, 이 파일의 기존 시나리오 테스트 전부가 그 형태로 자동 재검증되게 한다.
const docToken = (id: string) => `[\\[QA·폐기용\\] 제목](entity:doc:${id})`;
const storyToken = (id: string) => `[\\[QA·폐기용\\] 제목](entity:story:${id})`;

describe('computeSuggestion (story #2638) — AC1/AC3', () => {
  it('AC1 — PO 재발 메시지 재연: 승인 문구+draft doc 참조+게이트 부재 조합에서 제안이 뜬다', () => {
    const content = `${docToken(DOC_ID)} 승인 주시면 감사하겠습니다`;
    const byKey: Record<string, EntityStatusFetchState> = { [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } };
    const s = computeSuggestion(content, byKey);
    expect(s?.kind).toBe('approval');
    expect(s?.ref).toEqual({ type: 'doc', id: DOC_ID });
    expect(s?.endpoint).toBe(`/api/docs/${DOC_ID}/transition`);
    expect(s?.body).toEqual({ status: 'pending' });
  });

  it('AC3 음성대조 — 이미 게이트 있는(pending) doc엔 제안이 안 뜬다', () => {
    const content = `${docToken(DOC_ID)} 승인 주시면 감사하겠습니다`;
    const byKey: Record<string, EntityStatusFetchState> = { [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'pending' } };
    expect(computeSuggestion(content, byKey)).toBeNull();
  });

  it('AC3 음성대조 — 의도 문구 없는 doc 임베드엔 제안이 안 뜬다(과잉 제안 방지)', () => {
    const content = docToken(DOC_ID);
    const byKey: Record<string, EntityStatusFetchState> = { [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } };
    expect(computeSuggestion(content, byKey)).toBeNull();
  });

  it('상태 미해소(loading/미존재)면 제안이 안 뜬다 — "아직 모름"에서 섣불리 제안하지 않는다', () => {
    const content = `${docToken(DOC_ID)} 승인 주시면 감사하겠습니다`;
    expect(computeSuggestion(content, undefined)).toBeNull();
    expect(computeSuggestion(content, { [`doc:${DOC_ID}`]: { kind: 'loading' } })).toBeNull();
  });

  it('AC4 — 완료 보고 문구+story 참조+미완료 상태에서 완료 제안이 뜬다', () => {
    const content = `${storyToken(STORY_ID)} 작업 다 했습니다`;
    const byKey: Record<string, EntityStatusFetchState> = { [`story:${STORY_ID}`]: { kind: 'resolved', raw: 'in-progress' } };
    const s = computeSuggestion(content, byKey);
    expect(s?.kind).toBe('completion');
    expect(s?.endpoint).toBe(`/api/stories/${STORY_ID}`);
    expect(s?.body).toEqual({ status: 'done' });
  });

  it('완료 제안 음성대조 — 이미 done인 story엔 제안이 안 뜬다', () => {
    const content = `${storyToken(STORY_ID)} 작업 다 했습니다`;
    const byKey: Record<string, EntityStatusFetchState> = { [`story:${STORY_ID}`]: { kind: 'resolved', raw: 'done' } };
    expect(computeSuggestion(content, byKey)).toBeNull();
  });

  it('AC4 — 배정 문구+story 참조에서 배정 제안이 뜬다', () => {
    const content = `${storyToken(STORY_ID)} 이 작업 배정할게요`;
    const s = computeSuggestion(content, undefined);
    expect(s?.kind).toBe('assignment');
    expect(s?.endpoint).toBe(`/api/stories/${STORY_ID}`);
  });

  it('entityStatusByKey 키는 use-entity-status-batch.ts와 동형 소문자화 조회 — 대문자 UUID 토큰도 정상 매치', () => {
    const upperCaseId = DOC_ID.toUpperCase();
    const content = `${docToken(upperCaseId)} 승인 주시면 감사하겠습니다`;
    // 배치fetch 훅(use-entity-status-batch.ts:28)이 저장할 때도 항상 소문자 키다.
    const byKey: Record<string, EntityStatusFetchState> = { [`doc:${upperCaseId}`.toLowerCase()]: { kind: 'resolved', raw: 'draft' } };
    expect(computeSuggestion(content, byKey)?.kind).toBe('approval');
  });

  it('우선순위 — 승인 문구가 매치되면(draft doc 존재) 완료/배정 문구가 같이 있어도 승인 제안이 우선', () => {
    const content = `${docToken(DOC_ID)} 승인 주시면 감사하겠습니다. 작업은 다 했습니다.`;
    const byKey: Record<string, EntityStatusFetchState> = { [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } };
    expect(computeSuggestion(content, byKey)?.kind).toBe('approval');
  });
});
