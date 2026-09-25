// @vitest-environment jsdom
//
// [SID:4288] «화면 밖으로 밀어 숨기기» 종류 가드. 화면 밖 이동(translate 100% · -full)만으로 숨긴 요소는 Tab 순서에 남아 보이지 않는
// 곳에 초점이 간다(aria-hidden 속 초점 = 접근성 위반). 이름을 박은 다섯 자리가 아니라 앱 전체의 그 «모양»을 전수로 모아, 자리마다
// 둘 중 하나를 반드시 쓰게 잠근다(PO 04:24Z):
//   ⓐ 닫힌 서랍 — `closedDrawerProps(progress)`(aria-hidden + inert · 닫히면 초점 · 클릭에서 빠짐)
//   ⓑ 늘 닿아야 하는 막대(스크롤로 숨는 상단바 · 도구막대) — 같은 클래스 줄에 `focus-within:translate-…-0`(초점이 들어오면 다시 보임)
// 새로 생기는 여섯째 자리도 이 가드에 걸린다. 도달 0인 자리만 이유와 함께 EXCEPTIONS에 둔다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { closedDrawerProps } from './use-swipe-drawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
// EE 웹 코드도 같은 앱 화면이라 같이 훑는다(지금 0자리 · 상대경로는 `ee:`로 구분).
const EE_SRC = join(SRC, '..', '..', '..', 'ee', 'apps', 'web', 'src');

// 화면 밖 이동 모양 — 클래스(-translate-x-full · translate-y-full · -translate-y-[calc(100%+…)] 등)와 인라인 style(translateX(-100%) ·
// translateX(${(p - 1) * 100}%) 등). 스위치 손잡이(translate-x-[14px]) · 끌기(translate3d(px)) · 가운데 맞춤(-translate-x-1/2)은 100%가
// 아니라 부류 밖.
const CLASS_SHAPE = /(^|[\s'"`])-?translate-[xy]-(full|\[[^\]\s]*100%[^\]\s]*\])/;
const STYLE_SHAPE = /translate[XY]\(.*100.*%/; // 인자 안에 괄호가 올 수 있어(`(p - 1) * 100`) 같은 줄 전체로 본다
const REVEAL_ON_FOCUS = /focus-within:-?translate-[xy]-0/;
const DRAWER_HELPER = /closedDrawerProps\(/;
const ELEMENT_WINDOW = 15; // 같은 JSX 요소의 속성 범위(줄)

/** 도달 0인 자리만 — `상대경로:줄 내용 일부` → 이유. 지금은 0개. */
const EXCEPTIONS: Record<string, string> = {};

export interface OffscreenSite { file: string; line: number; text: string; kind: 'class' | 'style' }

export function findUnguardedOffscreen(file: string, src: string): OffscreenSite[] {
  const lines = src.split('\n');
  const out: OffscreenSite[] = [];
  lines.forEach((text, i) => {
    const kind = CLASS_SHAPE.test(text) ? 'class' : STYLE_SHAPE.test(text) ? 'style' : null;
    if (!kind) return;
    const windowText = lines.slice(Math.max(0, i - ELEMENT_WINDOW), i + ELEMENT_WINDOW + 1).join('\n');
    const guarded = (kind === 'class' && REVEAL_ON_FOCUS.test(text)) || DRAWER_HELPER.test(windowText);
    if (guarded) return;
    const key = Object.keys(EXCEPTIONS).find((k) => k.startsWith(`${file}:`) && text.includes(k.slice(file.length + 1)));
    if (key) return;
    out.push({ file, line: i + 1, text: text.trim(), kind });
  });
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, acc); continue; }
    if (/\.(tsx|ts)$/.test(name) && !/\.(test|spec)\.(tsx|ts)$/.test(name)) acc.push(p);
  }
  return acc;
}

const ALL = [
  ...walk(SRC).map((p) => ({ file: relative(SRC, p), src: readFileSync(p, 'utf8') })),
  ...(existsSync(EE_SRC) ? walk(EE_SRC).map((p) => ({ file: `ee:${relative(EE_SRC, p)}`, src: readFileSync(p, 'utf8') })) : []),
];

describe('화면 밖으로 밀어 숨기기 — 종류 가드([SID:4288])', () => {
  it('훑는 범위가 비어 있지 않다(웹 · EE 웹 뿌리)', () => {
    expect(ALL.filter((f) => !f.file.startsWith('ee:')).length).toBeGreaterThan(500);
    expect(existsSync(EE_SRC)).toBe(true);
    expect(ALL.some((f) => f.file.startsWith('ee:'))).toBe(true);
  });

  it('앱 전체에서 화면 밖 이동 자리마다 닫힌 서랍 헬퍼(inert) 또는 focus-within 드러내기를 쓴다', () => {
    const bad = ALL.flatMap(({ file, src }) => findUnguardedOffscreen(file, src));
    expect(bad, bad.map((b) => `${b.file}:${b.line} ${b.text}`).join('\n')).toEqual([]);
  });

  it('지금 잡히는 자리 전수(새 자리가 생기면 이 목록이 늘어난다 — 확인용)', () => {
    const sites = ALL.flatMap(({ file, src }) => src.split('\n').flatMap((t, i) => (CLASS_SHAPE.test(t) || STYLE_SHAPE.test(t) ? [`${file}:${i + 1}`] : [])));
    expect(sites.map((s) => s.replace(/:\d+$/, '')).sort()).toEqual([
      'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
      'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
      'components/docs/doc-editor.tsx',
      'components/nav/top-bar.tsx',
      'components/storage/storage-view.tsx',
    ]);
  });

  it.each([
    ['components/storage/storage-view.tsx', /\{\.\.\.closedDrawerProps\(folderDrawerProgress\)\}/, 'aria-hidden={folderDrawerProgress === 0}'],
    ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', /\{\.\.\.closedDrawerProps\(drawerProgress\)\}/, 'aria-hidden={drawerProgress === 0}'],
    ['components/nav/top-bar.tsx', / focus-within:translate-y-0/, ''],
    ['components/docs/doc-editor.tsx', / focus-within:translate-y-0 focus-within:pointer-events-auto/, ''],
    ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', / focus-within:translate-y-0/, ''],
  ] as const)('양성 대조 — %s에서 처방을 빼면 잡힌다', (file, remedy, replacement) => {
    const src = ALL.find((f) => f.file === file)!.src;
    expect(findUnguardedOffscreen(file, src)).toEqual([]);
    expect(findUnguardedOffscreen(file, src.replace(remedy, replacement)).length).toBeGreaterThan(0);
  });

  it('모양 판정 — 부류 밖(스위치 손잡이 · 가운데 맞춤 · 끌기)은 안 잡고, 화면 밖 이동은 잡는다', () => {
    const probe = (line: string) => findUnguardedOffscreen('x.tsx', line).length;
    expect(probe("className='translate-x-[14px]'")).toBe(0);
    expect(probe("className='-translate-x-1/2'")).toBe(0);
    expect(probe('transform: `translate3d(${x}px, ${y}px, 0)`')).toBe(0);
    expect(probe("className='-translate-x-full'")).toBe(1);
    expect(probe("hidden && 'translate-y-full'")).toBe(1);
    expect(probe("gnbHidden && '-translate-y-[calc(100%+var(--h))]'")).toBe(1);
    expect(probe('transform: `translateX(-100%)`')).toBe(1);
    expect(probe('transform: `translateX(${(p - 1) * 100}%)`')).toBe(1);
    // 클래스 자리는 «같은 줄»의 focus-within만 인정 — 옆 줄 다른 요소의 focus-within으로 통과하지 않는다.
    expect(probe("a && 'focus-within:translate-y-0'\nb && '-translate-y-full'")).toBe(1);
  });
});

describe('closedDrawerProps — React 19.2 불리언 inert가 실제 DOM 속성으로([SID:4288])', () => {
  it.each([[0, true], [0.4, false], [1, false]] as const)('progress %s → inert · aria-hidden %s', async (progress, closed) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<div data-testid="d" {...closedDrawerProps(progress)}><button type="button">x</button></div>); });
    const el = host.querySelector('[data-testid="d"]')!;
    expect(el.hasAttribute('inert')).toBe(closed);
    expect(el.getAttribute('aria-hidden')).toBe(String(closed));
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
