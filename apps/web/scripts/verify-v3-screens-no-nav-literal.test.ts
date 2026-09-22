// story #4004 AC1 — "화면 파일 안에 경로 문자열 리터럴 0(grep 결과 PR 본문)". 이
// 가드가 그 grep을 코드로 고정한다. 대상은 오늘·대화 두 v3 셸 화면 자신뿐(연결·규칙
// 화면은 story #4376 착지 뒤 별도 커밋으로 이 카드에 합류 — 그때 이 목록에 추가).
// #4017(nav-v3-flags-server.ts 단일소스, 이 카드 rebase 시점 develop에 아직 없음)이
// 착지하면 이 가드는 verify-nav-v3-single-source.ts로 흡수될 예정(중복 가드 임시
// 공존 — 그 시점에 이 파일은 지운다).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const DEST_LITERALS = ['/today', '/org-briefing', '/chats', '/chat', '/organization/insights-board', '/connect-rules'] as const;

const TARGET_FILES = [
  'components/today-v3/today-v3-screen.tsx',
  'components/chat-v3/chat-v3-screen.tsx',
] as const;

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('v3 셸 화면 — 목적지 문자열 리터럴 0(story #4004 AC1)', () => {
  it.each(TARGET_FILES)('%s에 목적지 리터럴이 하나도 없다', (relPath) => {
    const content = stripComments(readFileSync(path.join(SRC_ROOT, relPath), 'utf-8'));
    const found = DEST_LITERALS.filter((lit) => content.includes(`'${lit}'`) || content.includes(`"${lit}"`));
    expect(found).toEqual([]);
  });
});
