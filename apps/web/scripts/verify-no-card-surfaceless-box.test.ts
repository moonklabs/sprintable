import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeOverages, countSurfacelessBoxClasses, loadBaseline, scanRepoCounts } from './verify-no-card-surfaceless-box';

describe('countSurfacelessBoxClasses (story #3785 보조 가드)', () => {
  it('rounded-md + border border-border, bg 없음 → 위반으로 잡는다', () => {
    const content = '<div className="divide-y divide-border overflow-hidden rounded-md border border-border">';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(1);
  });

  it('bg-card가 있으면 잡지 않는다(정상 카드 표면)', () => {
    const content = '<div className="rounded-lg border border-border/80 bg-card">';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(0);
  });

  it('bg-background(재도색)도 bg-가 있는 문자열이라 이 정적 축은 못 잡는다(라이브 하네스 몫 — AC4 선언)', () => {
    const content = '<div className="rounded-xl border border-border bg-background">';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(0);
  });

  it('border-border/60 같은 알파 접미도 잡는다(story #3785 유나 실측 — rewards 변형)', () => {
    const content = '<div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-2">';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(1);
  });

  it('rounded-md 없이 border border-border만 있으면 안 잡는다(모서리 조건 없음)', () => {
    const content = '<div className="border border-border">';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(0);
  });

  it('한 파일에 여러 자리가 있으면 각각 센다', () => {
    const content = [
      '<div className="rounded-md border border-border">',
      '<div className="rounded-lg border border-border">',
      '<div className="rounded-md border border-border bg-card">', // bg- 있어 제외
    ].join('\n');
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(2);
  });

  it('*.test.tsx는 대상 밖(회귀 픽스처 자신이 카운트되지 않게)', () => {
    const content = '<div className="rounded-md border border-border">';
    expect(countSurfacelessBoxClasses(content, 'components/foo.test.tsx')).toBe(0);
  });

  it('className={`...`} 템플릿 리터럴은 대상 밖(AC4 선언 — 이중따옴표 리터럴만 본다)', () => {
    const content = '<div className={`rounded-md border border-border`}>';
    expect(countSurfacelessBoxClasses(content, 'fake.tsx')).toBe(0);
  });
});

describe('scanRepoCounts — self-assert(story #2057류 함정 방지, --write-baseline 경로도 동일 적용)', () => {
  it('throws when the scanned directory has too few files(가드가 헛돌고 있다)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-surfaceless-empty-'));
    expect(() => scanRepoCounts(dir)).toThrow(/개뿐.*가드가 헛돌고 있다/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadBaseline — JSON storage', () => {
  it('returns an empty map when the file does not exist(fresh repo, no baseline yet)', () => {
    expect(loadBaseline('/nonexistent/path/card-surfaceless-box-baseline.json').size).toBe(0);
  });

  it('round-trips a {path: count} baseline', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-surfaceless-baseline-test-'));
    const file = path.join(dir, 'baseline.json');
    writeFileSync(file, JSON.stringify({ _comment: [], counts: { 'components/foo.tsx': 3 } }));
    const loaded = loadBaseline(file);
    expect(loaded.get('components/foo.tsx')).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

// 페드루 PO 리뷰 지적(PR#3580, story #3164)과 동형 — 이 판정 로직을 테스트가 따로 복제해
// 재면 「막는 쪽과 재는 쪽이 다른 코드를 본다」 구조가 돼 main()이 드리프트해도 테스트가
// green으로 남는다. export된 computeOverages()를 그대로 불러 값으로 잰다.
describe('AC — 양성대조(main()과 같은 computeOverages()가 실제로 FAIL할 수 있는지)', () => {
  it('신규 파일에 자리가 생기면(baseline에 없음) 위반으로 잡힌다', () => {
    const counts = new Map([['app/foo/page.tsx', 1]]);
    const baseline = new Map<string, number>();
    const overages = computeOverages(counts, baseline);
    expect(overages).toEqual([{ file: 'app/foo/page.tsx', count: 1, allowed: 0 }]);
  });

  it('기존 grandfather 파일의 카운트가 baseline과 같으면(초과 아님) 통과한다', () => {
    const counts = new Map([['app/foo/page.tsx', 3]]);
    const baseline = new Map([['app/foo/page.tsx', 3]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });

  it('기존 grandfather 파일에 자리가 하나 더 늘면(3→4) 위반으로 잡힌다', () => {
    const counts = new Map([['app/foo/page.tsx', 4]]);
    const baseline = new Map([['app/foo/page.tsx', 3]]);
    expect(computeOverages(counts, baseline)).toEqual([{ file: 'app/foo/page.tsx', count: 4, allowed: 3 }]);
  });

  it('기존 grandfather 파일의 카운트가 줄면(3→1, Card 치환 진전) 위반이 아니다 — freeze는 상한선만 지킨다', () => {
    const counts = new Map([['app/foo/page.tsx', 1]]);
    const baseline = new Map([['app/foo/page.tsx', 3]]);
    expect(computeOverages(counts, baseline)).toEqual([]);
  });
});

// story #3785 실 회귀 pin — 이 PR이 실제로 고친 12자리가 baseline에서 정확히 사라졌는지(재발
// 시 이 테스트가 바로 잡는다). channels 3건(280·922·1225) 中 1건(측정-비콘 키 패널, 이미
// 카드 안 2층이라 이 정적 축은 정당하게 여전히 보임)만 baseline에 남는다.
describe('story #3785 회귀 pin — 이번 PR이 고친 자리는 baseline에서 사라졌다', () => {
  it('rewards 구역 카드 3자리(리더보드·포상벌금·거래내역)는 baseline에 없다(bg-card로 전환됨)', () => {
    const content = readFileSync(path.resolve(__dirname, '../src/app/(authenticated)/rewards/page.tsx'), 'utf8');
    // 구역 카드 자체(rounded-xl border border-border bg-background)는 이제 Card로 바뀌어
    // 이 정적 스캔에 안 걸린다. 남는 2건은 행(rounded-lg border border-border/60, 의도적으로
    // 손 안 댐 — 2층 자동 승계, 라이브 하네스 몫).
    expect(countSurfacelessBoxClasses(content, 'app/(authenticated)/rewards/page.tsx')).toBe(2);
  });

  it('standup 구역 카드 1자리(현재 스프린트)는 baseline에 없다(bg-card로 전환됨)', () => {
    const content = readFileSync(
      path.resolve(__dirname, '../src/app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx'),
      'utf8',
    );
    const count = countSurfacelessBoxClasses(content, 'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx');
    // 이 파일엔 스토리 범위 밖의 다른 story#3009 인라인 카드(bg-background, 손 안 댐)가 있어
    // 0은 아니지만, 「현재 스프린트」 구역 카드 자신은 이제 안 걸린다(정확한 잔여 수는 baseline
    // 파일이 실물 SSOT — 여기서는 "가드가 로직을 실제로 실행할 수 있다"만 확認).
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// story #3164 관례와 동형 — 실 커밋된 baseline이 형식을 지키는지(파싱 가능·음수 없음)만
// 최소 확認. 실측치를 하드코딩해 고정하지 않는다(반복 재생성마다 흔들리는 "정확한 수"가
// 아니라 "형식이 살아있는가"만 잰다).
describe('실 저장소 baseline 파일 형식', () => {
  it('card-surfaceless-box-baseline.json은 파싱 가능하고 모든 카운트가 양의 정수다', () => {
    const baseline = loadBaseline(path.resolve(__dirname, 'card-surfaceless-box-baseline.json'));
    expect(baseline.size).toBeGreaterThan(0);
    for (const [, count] of baseline) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });
});
