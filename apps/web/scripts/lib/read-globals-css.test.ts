// story 4919 — `var(--ds-*)`를 테마별 ds 값으로 푸는 도우미(대비 가드 입력용). 라이트 = :root 블록 안 · 다크 = .dark 블록 안, 그 밖은 건드리지 않는다.
import { describe, expect, it } from 'vitest';
import { parseDsThemes, resolveDsReferences } from './read-globals-css';

const DS = `
:root,
.ds-theme-light {
  --ds-surface: #ffffff;
  --ds-ink: #0f1420;
}
.dark {
  --ds-surface: #181c23;
  --ds-ink: #dfe2ec;
}
@theme { --spacing-ds-control-sm: 1.75rem; }
`;

describe('read-globals-css — ds 참조 풀기', () => {
  it('ds 파일에서 라이트(:root, .ds-theme-light) · 다크(.dark) 값을 따로 읽는다', () => {
    const t = parseDsThemes(DS);
    expect(t.light['--ds-surface']).toBe('#ffffff');
    expect(t.dark['--ds-surface']).toBe('#181c23');
  });

  it('globals의 :root 안은 라이트 값 · .dark 안은 다크 값으로 풀리고, 밖의 글은 그대로다', () => {
    const g = `:root {\n  --proof-panel: var(--ds-surface);\n  --x: color-mix(in srgb, var(--ds-ink) 50%, transparent);\n}\n.dark {\n  --proof-panel: var(--ds-surface);\n}\n.foo { color: var(--ds-ink); }`;
    const out = resolveDsReferences(g, DS);
    expect(out).toContain(':root {\n  --proof-panel: #ffffff;');
    expect(out).toContain('color-mix(in srgb, #0f1420 50%, transparent)');
    expect(out).toContain('.dark {\n  --proof-panel: #181c23;');
    expect(out).toContain('.foo { color: var(--ds-ink); }'); // 테마 블록 밖은 풀지 않는다
  });

  it('ds에 없는 이름을 참조하면 조용히 넘기지 않고 던진다', () => {
    expect(() => resolveDsReferences(':root { --a: var(--ds-nope); }', DS)).toThrow(/--ds-nope/);
  });
});
