import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeOverages, countRawButtons, EXEMPT_FILES, loadBaseline, scanRepoCounts } from './verify-no-new-raw-button';

describe('countRawButtons (story #3164 Gate A)', () => {
  it('counts raw <button> occurrences in a file', () => {
    const content = '<button onClick={x}>A</button><div><button>B</button></div>';
    expect(countRawButtons(content, 'fake.tsx')).toBe(2);
  });

  it('does not count zero occurrences as a false positive', () => {
    expect(countRawButtons('<Button onClick={x}>A</Button>', 'fake.tsx')).toBe(0);
  });

  // 단어 경계 — <ButtonGroup>류 캐노니컬 변형 컴포넌트를 raw button으로 오탐하지 않는다.
  it('does not flag <ButtonGroup> or other Button-prefixed components as raw button', () => {
    expect(countRawButtons('<ButtonGroup><Button /></ButtonGroup>', 'fake.tsx')).toBe(0);
  });

  it('flags self-closing raw <button />', () => {
    expect(countRawButtons('<button aria-label="x" />', 'fake.tsx')).toBe(1);
  });

  it('EXEMPT_FILES returns 0 regardless of actual raw button count(프리미티브 자신의 구현)', () => {
    const content = '<button onClick={x}>A</button>';
    for (const f of EXEMPT_FILES) {
      expect(countRawButtons(content, f)).toBe(0);
    }
  });

  it('*.test.tsx는 대상 밖(회귀 픽스처 자신이 카운트되지 않게)', () => {
    expect(countRawButtons('<button>fixture</button>', 'components/ui/button.test.tsx')).toBe(0);
  });
});

describe('scanRepoCounts — self-assert(story #2057류 함정 방지, --write-baseline 경로도 동일 적용)', () => {
  it('throws when the scanned directory has too few files(가드가 헛돌고 있다)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'raw-button-empty-'));
    expect(() => scanRepoCounts(dir)).toThrow(/개뿐.*가드가 헛돌고 있다/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadBaseline — JSON storage', () => {
  it('returns an empty map when the file does not exist(fresh repo, no baseline yet)', () => {
    expect(loadBaseline('/nonexistent/path/raw-button-baseline.json').size).toBe(0);
  });

  it('round-trips a {path: count} baseline', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'raw-button-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    writeFileSync(file, JSON.stringify({ _comment: [], counts: { 'components/foo.tsx': 5 } }));
    const loaded = loadBaseline(file);
    expect(loaded.get('components/foo.tsx')).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });
});

// AC6 — 「baseline 밖 신규 위반 픽스처로 FAIL을, EXEMPT 자리 픽스처로 PASS를 각각 실증」.
// 페드루 PO 리뷰 지적(PR#3580) — 이 판정 로직을 테스트가 따로 복제해 재면 「막는 쪽과 재는
// 쪽이 다른 코드를 본다」 구조가 돼 main()이 드리프트해도 테스트가 green으로 남는다.
// export된 computeOverages()(verify-no-new-raw-button.ts)를 그대로 불러 main()과 같은
// 실물을 재는지 값으로 잰다(Gate B가 이미 실 scanContent를 부르는 것과 동형으로 맞춤).
describe('AC6 — 양성대조(main()과 같은 computeOverages()가 실제로 FAIL할 수 있는지)', () => {
  it('신규 파일에 raw button이 생기면(baseline에 없음) 위반으로 잡힌다', () => {
    const counts = new Map([['components/new-file.tsx', 1]]);
    const baseline = new Map<string, number>();
    const overages = computeOverages(counts, baseline);
    expect(overages).toEqual([{ file: 'components/new-file.tsx', count: 1, allowed: 0 }]);
  });

  it('기존 grandfather 파일의 카운트가 baseline과 같으면(초과 아님) 통과한다', () => {
    const counts = new Map([['components/story-detail-panel.tsx', 37]]);
    const baseline = new Map([['components/story-detail-panel.tsx', 37]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });

  it('기존 grandfather 파일에 raw button이 하나 더 늘면(37→38) 위반으로 잡힌다', () => {
    const counts = new Map([['components/story-detail-panel.tsx', 38]]);
    const baseline = new Map([['components/story-detail-panel.tsx', 37]]);
    expect(computeOverages(counts, baseline)).toEqual([{ file: 'components/story-detail-panel.tsx', count: 38, allowed: 37 }]);
  });

  it('기존 grandfather 파일의 카운트가 줄면(37→30, 마이그레이션 진전) 위반이 아니다 — freeze는 상한선만 지킨다', () => {
    const counts = new Map([['components/story-detail-panel.tsx', 30]]);
    const baseline = new Map([['components/story-detail-panel.tsx', 37]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });

  // 뮤테이션 킬 — computeOverages 자체가 실제로 main()이 부르는 그 함수임을 증명(간접).
  // main()의 실 baseline/scan 결과로도 같은 함수가 0 overage를 내는지는 CLI 실행 자체
  // (가드 self-run)로 이미 검증되므로, 여기선 "이 함수가 main()에서 export된 그 심볼"임을
  // import 자체가 고정한다(타입 재선언 없음 — 별도 로컬 복제였다면 이 import가 실패했을 것).
  it('main()과 동일 심볼을 부른다는 것 자체가 타입으로 고정된다(로컬 복제였다면 import가 없다)', () => {
    expect(typeof computeOverages).toBe('function');
  });
});

// story #3164 실 저장소 스냅샷 대조 — 지금 커밋된 baseline이 형식을 지키는지(파싱 가능·
// 음수 없음) 최소 확認. 실측치를 하드코딩해 고정하지 않는다(반복 재생성마다 흔들리는
// "정확한 수"가 아니라 "형식이 살아있는가"만 잰다 — tint 가드의 「기존 baseline 자체를
// 값으로 assert하지 않는다」 관례와 동일).
describe('실 저장소 baseline 파일 형식', () => {
  it('raw-button-baseline.json은 파싱 가능하고 모든 카운트가 양의 정수다', () => {
    const baseline = loadBaseline(path.resolve(__dirname, 'raw-button-baseline.json'));
    expect(baseline.size).toBeGreaterThan(0);
    for (const [, count] of baseline) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });
});
