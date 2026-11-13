// 4913 — one empty shape on the «데스크톱 앱» screen: «원격 기기» used to be bare text and «연결된 기기» a dashed box. Both go through DesktopEmptyState (a dashed ds Card).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('[SID:4913] /desktop — one empty-state shape', () => {
  it.each([
    ['desktop-devices.tsx', 'desktop-devices-empty'],
    ['desktop-remote-devices.tsx', 'desktop-remote-devices-empty'],
  ])('%s draws its empty state through DesktopEmptyState', (f, testId) => {
    const c = src(f);
    expect(c).toContain("import { DesktopEmptyState } from '@/components/desktop/desktop-empty-state';");
    expect(c).toMatch(new RegExp(`<DesktopEmptyState [^>]*testId="${testId}"`));
  });

  it('neither list draws its own dashed box or bare empty line any more', () => {
    expect(src('desktop-devices.tsx')).not.toContain('border-dashed');
    expect(src('desktop-remote-devices.tsx')).not.toMatch(/<p className="text-sm text-muted-foreground">\{t\('empty'\)\}<\/p>/);
  });

  it('the shared empty state is the dashed ds Card', () => {
    const c = src('desktop-empty-state.tsx');
    expect(c).toContain("import { Card } from '@/components/ds/card';");
    expect(c).toContain('border-dashed');
  });
});
