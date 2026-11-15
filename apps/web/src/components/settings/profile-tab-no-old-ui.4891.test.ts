// story 4891 (UI-8 · settings › profile) — «프로필 탭이 그리는 부품 전부»에 옛 `@/components/ui/*` 부품이 하나도 없다. 파일 목록이 아니라 탭이 import하는 것 — 프로필 ①이 공용 `AvatarEditCard`
// (옛 Button · 10px 안내글)를 놓쳤던 자리(PO 11-11): 일곱 구역에서 시작해 `components/` 아래 import를 끝까지 따라가 옛 ui import를 모은다.
// 이름 붙은 예외 둘 — ds 쌍이 없는 것: `ui/toast`(앱 토스트 컨텍스트 훅) · `ui/tooltip`(ds Avatar가 쓰는 같은 부품). ds 폴더 안은 따라가지 않는다 — 새 부품의 속(예: ds Dialog가 감싼 ui/dialog 바탕)은 유나군 부품 쪽 일이고 이 탭의 «구역 부품» 몫이 아니다.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const ROOTS = [
  'my-profile-section', 'set-password-section', 'linked-accounts-section', 'two-factor-section', 'other-sessions-section',
  'my-notification-channel-section', 'blocked-users-section',
].map((n) => path.join(SRC, 'components', 'settings', `${n}.tsx`));
/** static `import … from '…'` / `export … from '…'` (single or double quotes), side-effect `import '…'`, dynamic `import('…')` — the one pattern the walk AND its self-test use */
const IMPORT_RE = /(?:(?:import|export)\s[^'"]*?from\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
const NO_DS_TWIN = new Set(['@/components/ui/toast', '@/components/ui/tooltip']);

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

/** every file under components/ the roots reach (ds/ and ui/ are not entered), and the old ui/ imports found on the way */
function walk() {
  const seen = new Set<string>();
  const olds: string[] = [];
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    // static `import … from '…'` / `export … from '…'` (single or double quotes), side-effect `import '…'`, and dynamic `import('…')`
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      if (/^@\/components\/ui\//.test(spec) && !NO_DS_TWIN.has(spec)) olds.push(`${path.relative(SRC, f)} → ${spec}`);
      const r = resolveImport(f, spec);
      if (r && r.includes(`${path.sep}components${path.sep}`) && !r.includes(`${path.sep}components${path.sep}ds${path.sep}`) && !r.includes(`${path.sep}components${path.sep}ui${path.sep}`) && !/\.test\./.test(r)) visit(r);
    }
  };
  ROOTS.forEach(visit);
  return { seen: [...seen].map((f) => path.relative(SRC, f)), olds };
}

describe('settings › profile tab: no old ui/ part anywhere in what it draws', () => {
  const { seen, olds } = walk();
  it('the walk reads double-quoted, side-effect and dynamic imports too (a part pulled in that way is not missed)', () => {
    const found = [...`import { A } from "@/components/ui/a";\nimport '@/components/ui/b';\nconst C = lazy(() => import('@/components/ui/c'));\nexport * from './d';`.matchAll(IMPORT_RE)].map((m) => m[1]);
    expect(found).toEqual(['@/components/ui/a', '@/components/ui/b', '@/components/ui/c', './d']);
  });
  it('the walk really reaches the shared parts (the photo card · its cropper · Avatar · the trust-score card) — it is not an empty pass', () => {
    for (const f of ['components/shared/avatar-edit-card.tsx', 'components/shared/avatar-cropper.tsx', 'components/cage/trust-score-card.tsx', 'components/settings/blocked-users-section.tsx']) {
      expect(seen, `the walk did not reach ${f}`).toContain(f);
    }
    expect(seen.length).toBeGreaterThanOrEqual(12);
  });
  it('none of them imports an old ui/ part (named exceptions: toast hook · tooltip)', () => {
    expect(olds, `old ui/ imports in the profile tab's parts:\n${olds.join('\n')}`).toEqual([]);
  });
  it('every component the profile tab names in page.tsx is one the walk starts from (or the ds Banner/Button) — a new one added there must be added to ROOTS, not slip by', () => {
    const page = readFileSync(path.join(SRC, 'app', '(authenticated)', 'settings', 'page.tsx'), 'utf8');
    const start = page.indexOf('<TabsContent value="profile">');
    const block = page.slice(start, page.indexOf('</TabsContent>', start));
    const named = [...new Set([...block.matchAll(/<([A-Z][A-Za-z]+)/g)].map((m) => m[1]))].filter((n) => n !== 'TabsContent');
    const rootNames = ROOTS.map((r) => path.basename(r, '.tsx').split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(''));
    const allowed = new Set([...rootNames, 'Banner', 'DsButton']);
    expect(named.filter((n) => !allowed.has(n)), 'components in the profile tab that the walk does not start from').toEqual([]);
    expect(named.filter((n) => rootNames.includes(n)).length, 'the profile tab names fewer sections than ROOTS lists').toBe(rootNames.length);
  });
  it('the profile tab\'s own load-failure line in page.tsx is a ds Banner, not the old Alert', () => {
    const page = readFileSync(path.join(SRC, 'app', '(authenticated)', 'settings', 'page.tsx'), 'utf8');
    const start = page.indexOf('<TabsContent value="profile">');
    const end = page.indexOf('</TabsContent>', start);
    const block = page.slice(start, end);
    expect(block).toContain('<Banner tone="failed"');
    expect(block).not.toMatch(/<Alert[\s>]/);
    expect(block).not.toContain('size="sm"');
  });
});
