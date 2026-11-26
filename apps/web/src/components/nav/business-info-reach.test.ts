// story 5031 (C1 step 2b, PO 11-26) — the business information is no longer a row at the bottom of the list column; it is reached from the account popover of the icon bar AND from the settings screen (nothing is dropped).
// Source reads, like the other structure pins of the shell: the popover draws the disclosure, the settings page draws the block.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('사업자 정보는 두 곳에서 닿는다(빠짐 0)', () => {
  it('아이콘 막대 계정 팝오버가 BusinessInfoDisclosure · 언어 · 테마를 싣는다', () => {
    const src = read('components/nav/rail-account.tsx');
    expect(src).toContain('<BusinessInfoDisclosure');
    expect(src).toContain('<LocaleSwitcher');
    expect(src).toContain('<ThemeToggle');
  });
  it('설정 화면이 BusinessInfoBlock을 싣는다', () => {
    expect(read('app/(authenticated)/settings/page.tsx')).toContain('<BusinessInfoBlock');
  });
  it('목록 칸(app-sidebar)은 더 싣지 않는다 — 두 곳에 겹쳐 보이지 않게', () => {
    const src = read('components/nav/app-sidebar.tsx');
    for (const part of ['<BusinessInfoDisclosure', '<LocaleSwitcher', '<ThemeToggle', '<ProfileMenu', "t('search')"]) expect(src, part).not.toContain(part);
  });
});
