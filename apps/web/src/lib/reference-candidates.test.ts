// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findReferenceCandidates, isCandidateRejected, rejectCandidate } from './reference-candidates';

// story #2059(kanban-board.test.tsx)와 동일 패턴 — jsdom/Node 네이티브 localStorage가
// 이 실행환경에서 온전치 않아(--localstorage-file 미설정 시 .clear() 없는 스텁) Map 기반
// 페이크로 통째로 교체한다.
let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

describe('findReferenceCandidates', () => {
  it('평문 #번호를 후보로 잡는다', () => {
    const result = findReferenceCandidates('이거 #2249 확認해줘');
    expect(result).toEqual([{ raw: '#2249', kind: 'number', value: '2249' }]);
  });

  it('평문 #슬러그(하이픈 포함)를 후보로 잡는다', () => {
    const result = findReferenceCandidates('doc #flow-map-blueprint-v1 참조');
    expect(result).toEqual([{ raw: '#flow-map-blueprint-v1', kind: 'slug', value: 'flow-map-blueprint-v1' }]);
  });

  it('하이픈 없는 순수 해시태그성 단어는 슬러그로 잡지 않는다(오탐 방지)', () => {
    const result = findReferenceCandidates('#urgent 부탁드려요');
    expect(result).toEqual([]);
  });

  it('한 자리 숫자(#1 같은)는 잡지 않는다(스토리 번호 관례상 노이즈 방지)', () => {
    const result = findReferenceCandidates('순서 #1 먼저요');
    expect(result).toEqual([]);
  });

  it('이미 entity 토큰인 것은 후보에서 뺀다(같은 클래스 재질문 방지)', () => {
    const result = findReferenceCandidates('[Fix #2249 bug](entity:story:11111111-1111-1111-1111-111111111111) 참고');
    expect(result).toEqual([]);
  });

  // story #2638 QA(2026-08-15) 파생 발견 — 정본 토큰(reference_token.py:_escape_title)이
  // 만드는 실 이스케이프 제목("[QA·폐기용] #2668 ..." 류, \[ \] 백슬래시 이스케이프)에서
  // 옛 정규식이 토큰 자체를 못 지워, 제목 속 "#2668"이 "이미 참조됨"인데도 다시 후보로
  // 새던 실 재현 버그. 위 40행 테스트(무괄호 제목)만으로는 이 케이스가 안 잡혔다.
  it('제목에 대괄호가 든 정본 이스케이프 entity 토큰도 후보에서 뺀다(실 재현 사례)', () => {
    const result = findReferenceCandidates(
      '[\\[QA·폐기용\\] #2668 확認용 문서](entity:doc:11111111-1111-1111-1111-111111111111) 승인 주시면',
    );
    expect(result).toEqual([]);
  });

  it('entity 토큰과 평문 후보가 섞여 있으면 평문 것만 잡는다', () => {
    const result = findReferenceCandidates(
      '[제목](entity:story:11111111-1111-1111-1111-111111111111) 관련해서 #2250 도 봐줘',
    );
    expect(result).toEqual([{ raw: '#2250', kind: 'number', value: '2250' }]);
  });

  it('같은 후보가 두 번 나오면 한 번만 잡는다(dedupe)', () => {
    const result = findReferenceCandidates('#2249 그리고 다시 #2249');
    expect(result).toHaveLength(1);
  });

  it('빈 문자열은 빈 배열을 낸다', () => {
    expect(findReferenceCandidates('')).toEqual([]);
  });
});

describe('거절 기억(localStorage, durable 아님, #2313 토큰 단위 스코프)', () => {
  beforeEach(() => {
    stubLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('거절 전엔 rejected가 아니다', () => {
    expect(isCandidateRejected('#2249')).toBe(false);
  });

  it('거절하면 그 토큰 문자열은 rejected로 남는다', () => {
    rejectCandidate('#2249');
    expect(isCandidateRejected('#2249')).toBe(true);
  });

  it('다른 토큰은 거절 영향을 안 받는다(양성대조, AC5)', () => {
    rejectCandidate('#2249');
    expect(isCandidateRejected('#2250')).toBe(false);
  });

  it('#2313 — 한 메시지에서 거절한 토큰은 다른(새) 메시지에 다시 쳐도 기억된다(토큰 단위 스코프, 메시지 단위 아님)', () => {
    // #2283 원 구현은 키가 `messageId::raw`라 이 경우 false가 나왔다 — 그게 #2313의 재현 결함.
    rejectCandidate('#2249');
    expect(isCandidateRejected('#2249')).toBe(true); // 어느 메시지에서 왔는지와 무관.
  });

  it('저장 키에 버전 프리픽스가 붙는다(#2313 PO 지시 — 키 모양 바뀌면 옛 값이 조용히 안 맞지 않고 깨끗이 무시)', () => {
    rejectCandidate('#2249');
    const raw = localStorage.getItem('sprintable:reference-candidates:rejected');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as string[];
    expect(stored).toEqual(['v1:#2249']);
  });
});
