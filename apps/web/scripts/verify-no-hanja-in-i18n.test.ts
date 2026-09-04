import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findHanjaInMessages, HANJA_EXCEPTIONS, scanLocaleFile } from './verify-no-hanja-in-i18n';

describe('findHanjaInMessages — 순수 판정 함수', () => {
  it('값에 섞인 한자를 키 경로와 함께 잡는다', () => {
    const findings = findHanjaInMessages({ attentionQueue: { actionConfirm: '확認' } }, 'f.json');
    expect(findings).toEqual([
      { file: 'f.json', key: 'attentionQueue.actionConfirm', chars: ['認'], value: '확認' },
    ]);
  });

  it('한 값에 서로 다른 한자가 여러 개면 전부(중복 제거해) 보고한다', () => {
    const findings = findHanjaInMessages({ a: '확定 후 확認' }, 'f.json');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.chars.sort()).toEqual(['定', '認']);
  });

  it('키 이름에만 한자가 있고 값은 순한글이면 잡지 않는다(AC2 — 값만 대상)', () => {
    const findings = findHanjaInMessages({ 確認키: '확인' }, 'f.json');
    expect(findings).toEqual([]);
  });

  it('한자가 없는 값은 통과한다(과잉살상 아님)', () => {
    const findings = findHanjaInMessages({ a: { b: 'hello', c: '안녕' } }, 'f.json');
    expect(findings).toEqual([]);
  });

  it('중첩 객체 전체를 재귀로 훑는다', () => {
    const findings = findHanjaInMessages({ a: { b: { c: '確定' } } }, 'f.json');
    expect(findings).toEqual([{ file: 'f.json', key: 'a.b.c', chars: ['確', '定'], value: '確定' }]);
  });

  it('HANJA_EXCEPTIONS에 등록된 file·key·char 조합은 건너뛴다', () => {
    const exceptions = HANJA_EXCEPTIONS as { file: string; key: string; char: string; reason: string; addedBy: string }[];
    exceptions.push({ file: 'f.json', key: 'a', char: '定', reason: 'test', addedBy: 'test' });
    try {
      const findings = findHanjaInMessages({ a: '確定' }, 'f.json');
      // 定는 예외 처리, 確는 예외 등록 안 됐으니 여전히 잡혀야 한다
      expect(findings).toEqual([{ file: 'f.json', key: 'a', chars: ['確'], value: '確定' }]);
    } finally {
      exceptions.length = 0;
    }
  });
});

describe('HANJA_EXCEPTIONS — AC2', () => {
  it('기본값은 빈 배열이다(사유 없는 예외 금지)', () => {
    expect(HANJA_EXCEPTIONS).toEqual([]);
  });
});

// AC3 — 이 가드가 «실패할 수 있음»을 코드로 고정한다. 일부러 한자를 넣은 값으로 스캔해
// 빨갛게 되는 것을 확인한다(잡지 못하는 가드는 「이상 없음」과 「검사가 안 돈다」를 구별해
// 주지 않는다). 이 테스트 자체가 그 고의 위반 재현이며, 실 파일은 건드리지 않는다.
describe('AC3 — 가드는 고의 한자 주입을 잡아낸다(양성대조)', () => {
  it('고의로 한자를 넣은 값은 빨갛게(finding 1건 이상) 된다', () => {
    const findings = findHanjaInMessages({ recruiter: { hint: '이 확認을 꼭' } }, 'ko.json');
    expect(findings.length).toBeGreaterThan(0);
  });
});

// story #3432 AC1 count-lock — 실 en.json/ko.json에 한자 섞인 값이 baseline(0)을 넘지 않는지
// 고정한다. AC1에서 실측 8건(전부 ko.json)을 이 스토리가 이미 정정했다 — 새로 생기는 것만 막는다.
describe('실 en.json/ko.json — count-lock(baseline 0)', () => {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

  it('en.json 값에 한자가 없다', () => {
    expect(scanLocaleFile(path.join(messagesDir, 'en.json'), 'en.json')).toEqual([]);
  });

  it('ko.json 값에 한자가 없다', () => {
    expect(scanLocaleFile(path.join(messagesDir, 'ko.json'), 'ko.json')).toEqual([]);
  });
});
