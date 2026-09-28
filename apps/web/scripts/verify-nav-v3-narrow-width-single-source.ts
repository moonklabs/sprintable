/**
 * story #4006(critical, 5pt) AC2 — v3 nav 칸의 폭·접힘은 공유 컴포넌트
 * (`NavV3Sidebar`, nav-v3-item-list.tsx)에서만 정한다. 이전엔 오늘·대화·연결·규칙
 * 3화면이 각자 `<aside className="flex w-[216px] ...">`를 손으로 그렸다(#4006 근본
 * 원인 — 「nav 칸을 복붙」, 3998 결함③). 이 가드는 그 3화면 소스 파일에 `w-[216px]`
 * 류 nav 고정폭 리터럴이 다시 나타나면 RED(주석 속 언급은 예외 — 실 className만
 * 스캔).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCREEN_FILES = [
  'src/components/today-v3/today-v3-screen.tsx',
  'src/components/chat-v3/chat-v3-screen.tsx',
  'src/components/connect-rules-v3/connect-rules-v3-screen.tsx',
] as const;

// className="..." / className={'...'} / className={`...`} 안쪽만 스캔(주석 속
// 백틱 인용은 이 정규식이 못 잡는다 — className 속성 자체가 아니라서).
const CLASS_ATTR_RE = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
const NAV_FIXED_WIDTH_RE = /\bw-\[21[0-9]px\]/;

export interface Violation {
  file: string;
  line: number;
  className: string;
}

export function scanFileForNavFixedWidth(relPath: string, content: string): Violation[] {
  const violations: Violation[] = [];
  let match: RegExpExecArray | null;
  CLASS_ATTR_RE.lastIndex = 0;
  while ((match = CLASS_ATTR_RE.exec(content)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (NAV_FIXED_WIDTH_RE.test(value)) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push({ file: relPath, line, className: value });
    }
  }
  return violations;
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function scanAllScreens(webRoot: string = WEB_ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const rel of SCREEN_FILES) {
    const content = readFileSync(path.join(webRoot, rel), 'utf8');
    violations.push(...scanFileForNavFixedWidth(rel, content));
  }
  return violations;
}

function main(): number {
  const violations = scanAllScreens();
  console.log(`[story #4006] v3 nav 고정폭 단일 출처 스캔 — 화면 파일 ${SCREEN_FILES.length}개 · 위반 ${violations.length}건`);
  if (violations.length > 0) {
    console.error('\nFAIL: 화면 파일에 nav 고정폭 리터럴이 재등장함(NavV3Sidebar 공유 컴포넌트 위반):');
    for (const v of violations) console.error(`  - ${v.file}:${v.line} — className="${v.className}"`);
    console.error('\n→ nav 폭·접힘은 @/components/nav/nav-v3-item-list.tsx의 NavV3Sidebar 하나만 정본이다.');
    return 1;
  }
  console.log('\nOK: 3화면 전부 nav 고정폭 리터럴 0(NavV3Sidebar 단일 출처).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
