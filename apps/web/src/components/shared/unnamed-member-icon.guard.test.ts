// story #4284(유나 · PO 판정) — 이름 없는 구성원의 신원 폴백 아이콘은 한 벌(에이전트 Bot · 사람 User)이고 정본은 UnnamedMemberIcon.
// 자리마다 lucide 아이콘을 직접 고르면 다시 갈라진다(이름 없다는 것만으로 사람 아이콘을 그려 에이전트가 사람처럼 보였다).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// 신원 폴백을 그리는 자리 — 전부 정본을 쓴다.
const SITES = [
  'components/shared/avatar.tsx',
  'app/(authenticated)/organization/trust/page.tsx',
  'components/verify/trust-seal.tsx',
  'components/kanban/story-card.tsx',
  'components/kanban/story-detail-panel.tsx',
];
// UserRound를 신원 폴백이 아닌 뜻으로 쓰는 자리(지원 위젯의 상담 상대 표식) — 범위 밖.
const USER_ROUND_ALLOWED = new Set(['components/support-widget/support-widget-panel.tsx']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'node_modules') sourceFiles(full, out); continue; }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(SRC, full));
  }
  return out;
}

describe('신원 폴백 아이콘 한 벌(story #4284)', () => {
  it.each(SITES)('⭐%s — UnnamedMemberIcon을 쓰고 lucide Bot · User · UserRound를 직접 들이지 않는다', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/<UnnamedMemberIcon\b/);
    const lucide = src.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)?.[1] ?? '';
    const names = lucide.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]);
    expect(names.filter((n) => n === 'Bot' || n === 'User' || n === 'UserRound')).toEqual([]);
  });

  it('⭐UserRound는 신원 폴백으로 안 쓴다 — 허용 목록(지원 위젯) 밖에서 들이는 파일 0 · 허용 항목은 실제로 쓴다', () => {
    const importers = sourceFiles(SRC).filter((rel) => /import\s*\{[^}]*\bUserRound\b[^}]*\}\s*from\s*'lucide-react'/.test(read(rel)));
    expect(importers.filter((rel) => !USER_ROUND_ALLOWED.has(rel))).toEqual([]);
    for (const rel of USER_ROUND_ALLOWED) expect(importers).toContain(rel);
  });

  it('정본은 에이전트 → Bot · 그 밖 → User', () => {
    const src = read('components/shared/unnamed-member-icon.tsx');
    expect(src).toMatch(/type === 'agent' \? Bot : User/);
  });
});
