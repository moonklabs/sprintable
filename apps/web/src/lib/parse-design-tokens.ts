import { readFileSync } from 'fs';
import { join } from 'path';

export interface ColorToken { name: string; cssVar: string; tailwind: string; }
export interface FontToken { name: string; cssVar: string; tailwind: string; }
export interface RadiusToken { name: string; cssVar: string; tailwind: string; }
export interface ColorGroup { label: string; tokens: ColorToken[]; }

const COLOR_EXCLUDED_PREFIXES = ['scrollbar', 'tiptap', 'radius', 'font'];
const GROUP_ORDER = ['Brand', 'Semantic', 'Status', 'Charts', 'Sidebar'];
const STATUS_NAMES = new Set(['success', 'warning', 'info', 'priority']);

function readGlobalsCss(): string {
  return readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');
}

function extractBlock(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return '';
  const start = css.indexOf('{', idx);
  if (start === -1) return '';
  let depth = 0;
  let end = start;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  return css.slice(start + 1, end);
}

function extractVarNames(block: string): string[] {
  const result: string[] = [];
  const re = /--([\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) result.push(m[1]!);
  return result;
}

function colorGroup(name: string): string {
  if (name.startsWith('brand')) return 'Brand';
  if (name.startsWith('sidebar')) return 'Sidebar';
  if (name.startsWith('chart')) return 'Charts';
  if (STATUS_NAMES.has(name)) return 'Status';
  return 'Semantic';
}

export function parseColorGroups(): ColorGroup[] {
  const css = readGlobalsCss();
  const rootBlock = extractBlock(css, ':root');
  const themeBlock = extractBlock(css, '@theme inline');

  const themeColorNames = new Set(
    extractVarNames(themeBlock)
      .filter(n => n.startsWith('color-'))
      .map(n => n.slice(6)),
  );

  const colorNames = extractVarNames(rootBlock).filter(
    n => n !== 'radius' && !COLOR_EXCLUDED_PREFIXES.some(p => n.startsWith(p)),
  );

  const grouped: Record<string, ColorToken[]> = {};
  for (const name of colorNames) {
    const group = colorGroup(name);
    if (!grouped[group]) grouped[group] = [];
    const tailwind = themeColorNames.has(name) ? `bg-${name}` : `bg-[--${name}]`;
    grouped[group]!.push({ name, cssVar: `--${name}`, tailwind });
  }

  return GROUP_ORDER.filter(g => grouped[g]).map(label => ({ label, tokens: grouped[label]! }));
}

export function parseFontTokens(): FontToken[] {
  const css = readGlobalsCss();
  const themeBlock = extractBlock(css, '@theme inline');
  const seen = new Set<string>();
  return extractVarNames(themeBlock)
    .filter(n => n.startsWith('font-'))
    .filter(n => { if (seen.has(n)) return false; seen.add(n); return true; })
    .map(n => {
      const suffix = n.slice(5);
      return {
        name: suffix.charAt(0).toUpperCase() + suffix.slice(1),
        cssVar: `--${n}`,
        tailwind: `font-${suffix}`,
      };
    });
}

export function parseRadiusTokens(): RadiusToken[] {
  const css = readGlobalsCss();
  const rootBlock = extractBlock(css, ':root');
  const themeBlock = extractBlock(css, '@theme inline');
  const tokens: RadiusToken[] = [];

  if (/--radius\s*:/.test(rootBlock)) {
    tokens.push({ name: 'base', cssVar: '--radius', tailwind: 'rounded' });
  }

  const SM_LG_MAP: Record<string, string> = { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg' };
  extractVarNames(themeBlock)
    .filter(n => n.startsWith('radius-'))
    .forEach(n => {
      const suffix = n.slice(7);
      tokens.push({ name: suffix, cssVar: `--${n}`, tailwind: SM_LG_MAP[suffix] ?? `rounded-${suffix}` });
    });

  return tokens;
}
