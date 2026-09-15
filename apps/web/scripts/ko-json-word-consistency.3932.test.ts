import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// story #3932 — "§⑤ 같은 사실 두 낱말 잔존" — 4개 네임스페이스(loops/hypotheses/goals/
// sprints)가 같은 사실("가설을 적는 입력란의 라벨")을 가리키면서 loops만 "가설 내용"으로
// 남아 있던 잔존 불일치. AC2 정정(PO, 2026-09-15) — hypotheses.statementField의 en 값이
// "Hypothesis"(다른 3키는 "Hypothesis statement")라 "같은 en 자동 그룹"은 신뢰할 수 없어,
// PO가 4키를 직접 명시 나열했다. 그 4키가 지금 전부 "가설 문장"으로 같다는 것을 고정한다.
const WORD_CONSISTENCY_KEYS = [
  'loops.createLoopStatementLabel',
  'hypotheses.statementField',
  'goals.declareStatementLabel',
  'sprints.declareStatementLabel',
] as const;

function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function loadKo(): Record<string, unknown> {
  const messagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
  return JSON.parse(readFileSync(path.join(messagesDir, 'ko.json'), 'utf8')) as Record<string, unknown>;
}

describe('ko.json — loops/hypotheses/goals/sprints의 "가설 문장" 라벨 4키 등식(story #3932 AC2)', () => {
  it('⭐4키가 전부 "가설 문장"으로 같다', () => {
    const ko = loadKo();
    for (const key of WORD_CONSISTENCY_KEYS) {
      expect(getByPath(ko, key)).toBe('가설 문장');
    }
  });

  it('양성대조 — loops.createLoopStatementLabel만 옛 표현("가설 내용")으로 되돌리면 등식이 깨진다', () => {
    const ko = loadKo();
    const mutated: Record<string, unknown> = {
      ...ko,
      loops: { ...(ko.loops as Record<string, unknown>), createLoopStatementLabel: '가설 내용' },
    };
    const values = WORD_CONSISTENCY_KEYS.map((key) => getByPath(mutated, key));
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(getByPath(mutated, 'loops.createLoopStatementLabel')).not.toBe('가설 문장');
  });

  it('실 ko.json — AC1 완결 확인: "가설 내용" 리터럴이 값에 더 이상 없다', () => {
    const ko = loadKo();
    const text = JSON.stringify(ko);
    expect(text.includes('가설 내용')).toBe(false);
  });
});
