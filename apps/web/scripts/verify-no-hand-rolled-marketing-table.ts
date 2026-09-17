/**
 * story #4014(유나 시안 7c197474 AC1) — 좁은 폭 마케팅 목록 표 3곳(블로그 포스트·채널
 * 포스트·성과 보드)이 손으로 `<table>`을 다시 조립하지 않고 공용
 * `components/shared/responsive-data-table.tsx`(ResponsiveDataTable)를 쓰는지 고정한다.
 * baseline 없음(이 3파일은 정확히 알려진 대상 — 카운트 동결이 아니라 절대 0건).
 *
 * ⚠️이 가드가 «못 잡는» 것: JSX `<table` 문자열 리터럴만 본다 — 동적 문자열 조립으로
 * 표를 만드는 경우(이 코드베이스 관례상 없음)는 스캔 밖.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// story #4014 대상 3파일(시안 §3 ①②③) — 새 화면이 늘면 이 목록에 추가.
export const TARGET_FILES = [
  'src/app/(authenticated)/content/page.tsx',
  'src/app/(authenticated)/content/channel-posts/page.tsx',
  'src/app/(authenticated)/organization/insights-board/page.tsx',
] as const;

const TABLE_TAG_RE = /<table\b/;

export function hasHandRolledTable(content: string): boolean {
  return TABLE_TAG_RE.test(content);
}

function main(): number {
  const violations: string[] = [];
  for (const rel of TARGET_FILES) {
    const full = path.join(REPO_ROOT, rel);
    const content = readFileSync(full, 'utf-8');
    if (hasHandRolledTable(content)) violations.push(rel);
  }

  if (violations.length > 0) {
    console.error(
      `FAIL: 아래 파일이 <table>을 직접 조립합니다 — ResponsiveDataTable(components/shared/` +
      `responsive-data-table.tsx)을 쓸 것(story #4014 AC1):\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    return 1;
  }
  console.log(`OK: 대상 ${TARGET_FILES.length}파일 모두 <table> 직접 조립 0건(ResponsiveDataTable 경유).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
