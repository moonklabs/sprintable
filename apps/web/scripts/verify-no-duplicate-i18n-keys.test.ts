import { describe, expect, it } from 'vitest';
import { findDuplicateSiblingKeys, scanLocaleFile } from './verify-no-duplicate-i18n-keys';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// parseJsonPreservingDuplicates는 export 안 함(내부 구현) — findDuplicateSiblingKeys에 직접
// PairsObject를 만들어 넣는 대신, scanLocaleFile로 실제 파일 스캔 경로를 통째로 검증한다.
// 순수 판정 로직(findDuplicateSiblingKeys) 단위 테스트는 파서 결과 shape을 손으로 만들어 검증.

describe('findDuplicateSiblingKeys — 순수 판정 함수', () => {
  it('같은 부모 안 중복 키를 잡는다(값 다름)', () => {
    const obj = { __pairs: [['a', 1], ['a', 2]] } as never;
    const findings = findDuplicateSiblingKeys(obj, 'f.json');
    expect(findings).toEqual([{ file: 'f.json', path: 'a', value1: 1, value2: 2, sameValue: false }]);
  });

  it('값이 같은 중복도 잡되 sameValue=true로 구분한다', () => {
    const obj = { __pairs: [['a', 'x'], ['a', 'x']] } as never;
    const findings = findDuplicateSiblingKeys(obj, 'f.json');
    expect(findings[0]!.sameValue).toBe(true);
  });

  it('중첩 객체 안 중복은 부모 경로를 붙여 보고한다', () => {
    const obj = {
      __pairs: [['goals', { __pairs: [['loading', 'A'], ['loading', 'B']] }]],
    } as never;
    const findings = findDuplicateSiblingKeys(obj, 'f.json');
    expect(findings).toEqual([{ file: 'f.json', path: 'goals.loading', value1: 'A', value2: 'B', sameValue: false }]);
  });

  it('다른 부모 밑의 같은 이름 키는 중복이 아니다(진짜 sibling만)', () => {
    const obj = {
      __pairs: [
        ['a', { __pairs: [['loading', 'A']] }],
        ['b', { __pairs: [['loading', 'B']] }],
      ],
    } as never;
    const findings = findDuplicateSiblingKeys(obj, 'f.json');
    expect(findings).toEqual([]);
  });

  it('3번 이상 반복되면 중복 건수만큼(N-1) 잡는다', () => {
    const obj = { __pairs: [['a', 1], ['a', 2], ['a', 3]] } as never;
    const findings = findDuplicateSiblingKeys(obj, 'f.json');
    expect(findings).toHaveLength(2);
  });
});

describe('scanLocaleFile — AC4 양성/음성대조(실 파일 파싱 경유)', () => {
  const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

  it('양성대조 — sibling 중복이 있는 fixture 파일에서 정확히 잡는다', () => {
    const findings = scanLocaleFile(path.join(fixturesDir, 'duplicate.json'), 'duplicate.json');
    expect(findings).toEqual([
      { file: 'duplicate.json', path: 'goals.loading', value1: 'A', value2: 'B', sameValue: false },
    ]);
  });

  it('음성대조 — 정상(중복 없는) fixture 파일은 0건(과잉살상 아님)', () => {
    const findings = scanLocaleFile(path.join(fixturesDir, 'clean.json'), 'clean.json');
    expect(findings).toEqual([]);
  });
});

// story #2395 AC1 count-lock — 실제 en.json/ko.json에 sibling 중복이 baseline(0)을 넘지
// 않는지 고정. 이 PR이 실측 4건(goals.loading·goals.backToList, en/ko 각 2쌍)을 이미 제거했다
// — 새로 생기는 것만 막는다(alembic 형제-PR 가드 story #2401과 동일 관례).
describe('실 en.json/ko.json — count-lock(baseline 0)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

  it('en.json에 sibling 중복 키가 없다', () => {
    expect(scanLocaleFile(path.join(messagesDir, 'en.json'), 'en.json')).toEqual([]);
  });

  it('ko.json에 sibling 중복 키가 없다', () => {
    expect(scanLocaleFile(path.join(messagesDir, 'ko.json'), 'ko.json')).toEqual([]);
  });
});
