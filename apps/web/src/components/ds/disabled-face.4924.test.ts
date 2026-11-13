// 4924 — the disabled face of the design system is ONE solid face. It was a dashed outline on a transparent face (the unchosen mock «C 데이북»). This guard pins it for all eight parts and prints the numbers
// (OKLab L of the face against the page and against each enabled face, and ink-3's contrast on the face) from the real token values, light and dark.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARIA_DISABLED_FACE, DATA_DISABLED_FACE, DATA_DISABLED_INDETERMINATE_FACE, DISABLED_FACE } from './disabled-face';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** the eight parts that draw a disabled state, and which constants each must take */
const PARTS: Record<string, string[]> = {
  'button.tsx': ['DISABLED_FACE', 'ARIA_DISABLED_FACE'],
  'icon-button.tsx': ['DISABLED_FACE', 'ARIA_DISABLED_FACE'],
  'input.tsx': ['DISABLED_FACE'], // Input and Textarea
  'select.tsx': ['DISABLED_FACE'],
  'date-picker.tsx': ['DISABLED_FACE'],
  'checkbox.tsx': ['DATA_DISABLED_FACE', 'DATA_DISABLED_INDETERMINATE_FACE'],
  'radio.tsx': ['DATA_DISABLED_FACE'],
  'toggle.tsx': ['DATA_DISABLED_FACE'],
};
const DASHED_DISABLED = /(?:disabled|data-disabled|aria-disabled)[^\s'"`]*:border-dashed/;

describe('[SID:4924] ds — one solid disabled face', () => {
  it.each(Object.entries(PARTS))('⭐%s takes the shared constants and spells no dashed disabled look of its own', (file, names) => {
    const c = code(file);
    for (const n of names) expect(c, `${file} uses ${n}`).toContain('${' + n + '}');
    expect(c, `${file} imports ./disabled-face`).toContain("from './disabled-face'");
    expect(c, `${file}: no dashed border on a disabled state`).not.toMatch(DASHED_DISABLED);
    expect(c, `${file}: no hand-written disabled face`).not.toMatch(/(?:^|[\s'"`])(?:aria-|data-)?disabled:(?:data-[\w-]+:)?(?:bg-transparent|border-ds-line-control)/);
  });

  it('⭐no ds part (any file in components/ds) draws a dashed disabled state — a new part cannot bring the dashed look back', () => {
    const offenders = readdirSync(__dirname)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .filter((f) => DASHED_DISABLED.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('⭐a disabled DatePicker with a value shows the muted text (the value span does not force text-ds-ink), and an invalid disabled checkbox / radio keeps its failed border', () => {
    expect(code('date-picker.tsx')).not.toMatch(/shown \? 'text-ds-ink'/);
    for (const f of ['checkbox.tsx', 'radio.tsx']) {
      expect(code(f), f).toContain('data-disabled:aria-invalid:border-ds-failed');
      expect(code(f), `${f} checked`).toContain('data-disabled:data-checked:aria-invalid:border-ds-failed'); // the checked-disabled rule would otherwise win over the invalid one
    }
    expect(code('checkbox.tsx')).toContain('data-disabled:data-indeterminate:aria-invalid:border-ds-failed');
  });

  it('the constants are the solid face: line border · surface-high face · ink-3 text — and none is dashed or transparent', () => {
    for (const c of [DISABLED_FACE, ARIA_DISABLED_FACE, DATA_DISABLED_FACE, DATA_DISABLED_INDETERMINATE_FACE]) {
      expect(c).not.toMatch(/dashed|transparent/);
      expect(c).toMatch(/border-ds-line(\s|$)/);
      expect(c).toContain('bg-ds-surface-high');
    }
    expect(DISABLED_FACE).toContain('disabled:text-ds-ink-3');
    expect(ARIA_DISABLED_FACE).toContain('aria-disabled:text-ds-ink-3');
    expect(DATA_DISABLED_FACE).toContain('data-disabled:text-ds-ink-3');
  });

  describe('the face in numbers (real token values · OKLab L · WCAG contrast)', () => {
    const css = read('../../styles/design-system.css');
    const block = (selector: string) => {
      const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
      if (!m) throw new Error(`block ${selector} not found`);
      return Object.fromEntries([...m[1].matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()])) as Record<string, string>;
    };
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const rgb = (hex: string) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
    const lightness = (hex: string) => {
      const [r, g, b] = rgb(hex);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    };
    const relative = (hex: string) => { const [r, g, b] = rgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a: string, b: string) => { const [hi, lo] = [relative(a), relative(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

    it.each([['light', ':root'], ['dark', '.dark']])('%s: ink-3 text stays ≥ 4.5:1 on the face, and the face is visibly not the enabled primary / page face', (_name, sel) => {
      const t = block(sel!);
      const face = t['surface-high']!;
      expect(contrast(t['ink-3']!, face)).toBeGreaterThanOrEqual(4.5);
      // the enabled primary fill is far from the disabled face (it loses its colour)
      expect(Math.abs(lightness(face) - lightness(t.action!))).toBeGreaterThan(0.3);
      // the enabled secondary button / quiet surfaces sit on the page: the face is a step off it (light −0.052 · dark +0.096)
      expect(Math.abs(lightness(face) - lightness(t.background!))).toBeGreaterThan(0.04);
      // the disabled border is the faint solid `line`, no longer the 3:1 control border: the part loses its «pressable» edge in both themes
      expect(contrast(t['line-control']!, t.background!)).toBeGreaterThan(contrast(t.line!, t.background!) + 1.5);
    });

    it('prints the table for the PR body', () => {
      const rows = [['light', ':root'], ['dark', '.dark']].map(([name, sel]) => {
        const t = block(sel!);
        const f = lightness(t['surface-high']!);
        return `${name}: face ${t['surface-high']} · ΔL vs page ${(f - lightness(t.background!)).toFixed(3)} · vs input face(sunk) ${(f - lightness(t['surface-sunk']!)).toFixed(3)} · vs primary fill ${(f - lightness(t.action!)).toFixed(3)} · ink-3 on face ${contrast(t['ink-3']!, t['surface-high']!).toFixed(2)}:1`;
      });
      console.info(rows.join('\n'));
      expect(rows).toHaveLength(2);
    });
  });
});
