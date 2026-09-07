import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeOverages, findRepeatedRowActionHits, loadBaseline, runSelfTest, scanRepoCounts,
} from './verify-repeated-row-action-names';

describe('findRepeatedRowActionHits (story #3592 §22-18)', () => {
  it('flags a static-label button inside .map() with no aria-label', () => {
    const content = `
      {items.map((item) => (
        <li key={item.id}>
          <Button onClick={() => onDo(item)}>{t('doCta')}</Button>
        </li>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(1);
  });

  it('does not flag a button that already has aria-label(있다/없다만 봄 — ㉠)', () => {
    const content = `
      {items.map((item, i) => (
        <Button aria-label={t('doAriaLabel', { n: i + 1 })}>{t('doCta')}</Button>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(0);
  });

  it('does not flag a button whose children already reference the loop variable(이미 항목별로 갈림)', () => {
    const content = `
      {items.map((item) => (
        <Button onClick={() => onDo(item)}>{item.name}을 처리</Button>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(0);
  });

  it('flags lowercase <button> too, not just <Button>', () => {
    const content = `
      {items.map((item) => (
        <button onClick={() => onDo(item)}>{t('doCta')}</button>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(1);
  });

  it('does not flag onClick/key referencing the loop var when the visible label does not(comments-section 실사례 — ㉠㉡ 오탐 방지 핵심)', () => {
    const content = `
      {comments.map((comment) => (
        <li key={comment.id}>
          <Button onClick={() => onReply(comment)} data-testid="comments-item-reply">
            {t('commentsReplyCta')}
          </Button>
        </li>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(1);
  });

  it('counts 2 separate repeated buttons in the same map block(comments-section 처방 前 실측치)', () => {
    const content = `
      {comments.map((comment) => (
        <li key={comment.id}>
          <Button onClick={() => onConvertToTask(comment)}>{t('commentsConvertToTaskCta')}</Button>
          <Button onClick={() => onReply(comment)}>{t('commentsReplyCta')}</Button>
        </li>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(2);
  });

  it('does not flag a self-closing button with aria-label but does flag one without(icon-only 버튼)', () => {
    const withLabel = `{items.map((item, i) => (<Button aria-label={t('x', { n: i })} />))}`;
    const withoutLabel = `{items.map((item) => (<Button />))}`;
    expect(findRepeatedRowActionHits(withLabel).length).toBe(0);
    expect(findRepeatedRowActionHits(withoutLabel).length).toBe(1);
  });

  it('destructuring params(㉥) — cannot determine the loop var, so it flags conservatively rather than silently skipping', () => {
    const content = `
      {entries.map(([key, value]) => (
        <Button onClick={() => onDo(key)}>{t('doCta')}</Button>
      ))}
    `;
    expect(findRepeatedRowActionHits(content).length).toBe(1);
  });

  it('a plain, non-JSX-returning .map() with no buttons produces 0 hits(빠른 bail)', () => {
    const content = `const ids = items.map((item) => item.id);`;
    expect(findRepeatedRowActionHits(content).length).toBe(0);
  });
});

describe('scanRepoCounts — self-assert(story #2057류 함정 방지)', () => {
  it('throws when the scanned directory has too few files(가드가 헛돌고 있다)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'row-action-empty-'));
    expect(() => scanRepoCounts(dir)).toThrow(/개뿐.*가드가 헛돌고 있다/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadBaseline — JSON storage', () => {
  it('returns an empty map when the file does not exist(fresh repo, no baseline yet)', () => {
    expect(loadBaseline('/nonexistent/path/repeated-row-action-names-baseline.json').size).toBe(0);
  });

  it('round-trips a {path: count} baseline', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'row-action-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    writeFileSync(file, JSON.stringify({ _comment: [], counts: { 'components/foo.tsx': 3 } }));
    const loaded = loadBaseline(file);
    expect(loaded.get('components/foo.tsx')).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

// AC6 — main()과 같은 computeOverages()를 그대로 불러 판정 로직 드리프트를 막는다
// (verify-no-new-raw-button.ts 페드루 PO 리뷰 지적과 동일 계약).
describe('AC6 — 양성대조(main()과 같은 computeOverages()가 실제로 FAIL할 수 있는지)', () => {
  it('신규 파일에 위반이 생기면(baseline에 없음) 잡힌다', () => {
    const counts = new Map([['components/new-file.tsx', 1]]);
    const baseline = new Map<string, number>();
    expect(computeOverages(counts, baseline)).toEqual([{ file: 'components/new-file.tsx', count: 1, allowed: 0 }]);
  });

  it('기존 grandfather 파일 카운트가 baseline과 같으면 통과한다', () => {
    const counts = new Map([['components/x.tsx', 2]]);
    const baseline = new Map([['components/x.tsx', 2]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });

  it('기존 grandfather 파일에 위반이 하나 더 늘면(2→3) 잡힌다', () => {
    const counts = new Map([['components/x.tsx', 3]]);
    const baseline = new Map([['components/x.tsx', 2]]);
    expect(computeOverages(counts, baseline)).toEqual([{ file: 'components/x.tsx', count: 3, allowed: 2 }]);
  });

  it('기존 grandfather 파일 카운트가 줄면(2→0, 수리 진전) 위반이 아니다 — freeze는 상한선만 지킨다', () => {
    const counts = new Map<string, number>();
    const baseline = new Map([['components/x.tsx', 2]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });
});

// AC5 — 유나 아티팩트 856d868c: --selftest 양방향(처방 前 2건·처방 後 0건) 자체 대조.
describe('AC5 — --selftest 양방향 자체 대조', () => {
  it('처방 前 픽스처는 2건, 처방 後 픽스처는 0건 — runSelfTest()가 true를 낸다', () => {
    expect(runSelfTest()).toBe(true);
  });

  // 뮤테이션 대조 — findRepeatedRowActionHits 자체가 고장 나면(예: aria-label 체크를
  // 지워버리면) self-test가 그 즉시 false로 떨어져야 한다. runSelfTest 내부 로직을
  // 직접 재현해 실증(export된 함수가 실제로 뮤테이션에 반응하는지 값으로 확認).
  it('뮤테이션 대조 — 처방 後 픽스처에 aria-label을 다시 지우면 self-test가 실패로 돌아선다', () => {
    const afterButNoAriaLabel = `
      {comments.map((comment) => (
        <Button onClick={() => onConvertToTask(comment)}>{t('commentsConvertToTaskCta')}</Button>
      ))}
    `;
    // 처방 前(2건 기대)과 무관하게, "처방 後"라 주장하는 픽스처가 실제로는 0건을 못
    // 내면(=아직 안 고쳐졌으면) self-test 계약(before===2 && after===0)이 깨진다.
    expect(findRepeatedRowActionHits(afterButNoAriaLabel).length).not.toBe(0);
  });
});
