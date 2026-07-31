// story #2328(C-11 ㉡층, 유나 규격 2026-07-29) — 의존성 고르기 패널의 "후보 vs 검색" 전환
// 판정. StoryDetailPanel 전체 마운트 없이 순수 함수만 격리 검증(같은 이유로 huge prop
// surface라 전체 마운트 테스트가 비실용적 — description-viewer.test.tsx와 동일 관례).
import { describe, expect, it } from 'vitest';
import { selectDepPickerItems, extractReferenceCandidates } from './story-detail-panel';

interface Item { id: string; title: string }

const candidates: Item[] = [{ id: 'c1', title: '후보 스토리' }];
const searchResults: Item[] = [{ id: 's1', title: '검색 결과 스토리' }];

describe('selectDepPickerItems', () => {
  it('①빈 입력이면 후보를 보인다', () => {
    expect(selectDepPickerItems('', candidates, searchResults)).toEqual({ items: candidates, showingCandidates: true });
  });

  it('①1글자면 후보를 보인다', () => {
    expect(selectDepPickerItems('a', candidates, searchResults)).toEqual({ items: candidates, showingCandidates: true });
  });

  it('①공백만 있어도(trim 후 0글자) 후보를 보인다 — "다 지운 것"과 같은 상태', () => {
    expect(selectDepPickerItems('   ', candidates, searchResults)).toEqual({ items: candidates, showingCandidates: true });
  });

  it('②2글자 이상이면 검색 결과로 갈아치운다', () => {
    expect(selectDepPickerItems('ab', candidates, searchResults)).toEqual({ items: searchResults, showingCandidates: false });
  });

  it('③후보와 검색 결과를 섞지 않는다 — 2글자 이상일 때 결과 배열엔 후보가 하나도 없다', () => {
    const { items } = selectDepPickerItems('스토리', candidates, searchResults);
    expect(items.some((i) => candidates.includes(i))).toBe(false);
  });

  it('2글자 이상에서 다시 1글자로 지우면(재요청 없이) held 후보가 그대로 복원된다', () => {
    // depCandidates는 호출부가 들고 있는 held state를 그대로 넘긴다 — 이 함수 자체는 상태를
    // 안 가지므로, 같은 candidates 참조를 다시 넘기면 그대로 복원되는 것이 곧 "재요청 없음"의
    // 증거다(별도 fetch 트리거가 이 함수 안에 없다는 것 = 구조적으로 재요청이 없다).
    const afterTyping = selectDepPickerItems('스토리', candidates, searchResults);
    expect(afterTyping.showingCandidates).toBe(false);
    const afterClearing = selectDepPickerItems('스', candidates, searchResults);
    expect(afterClearing).toEqual({ items: candidates, showingCandidates: true });
  });
});

describe('extractReferenceCandidates — story #2328, BE(PR#2659)는 필터가 아니라 재정렬만 한다', () => {
  it('is_reference_candidate===true인 것만 남긴다(false·undefined는 제외)', () => {
    const rows = [
      { id: 'a', title: 'A', is_reference_candidate: true, matched_snippet: '본문 발췌' },
      { id: 'b', title: 'B', is_reference_candidate: false },
      { id: 'c', title: 'C' },
    ];
    expect(extractReferenceCandidates(rows, 'self')).toEqual([{ id: 'a', title: 'A', matched_snippet: '본문 발췌' }]);
  });

  it('자기 자신은 후보여도 제외한다', () => {
    const rows = [{ id: 'self', title: 'Self', is_reference_candidate: true }];
    expect(extractReferenceCandidates(rows, 'self')).toEqual([]);
  });

  it('상한 6개 — 기존 검색 결과 cap과 동일', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: `C${i}`, is_reference_candidate: true }));
    expect(extractReferenceCandidates(rows, 'self')).toHaveLength(6);
  });

  it('matched_snippet이 없으면(null·undefined) 그대로 넘긴다 — 지어내지 않는다', () => {
    const rows = [{ id: 'a', title: 'A', is_reference_candidate: true, matched_snippet: null }];
    expect(extractReferenceCandidates(rows, 'self')[0]!.matched_snippet).toBeNull();
  });
});
