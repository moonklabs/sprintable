// @vitest-environment jsdom
//
// [SID:4288] «화면 밖으로 밀어 숨기기» 종류 가드. 화면 밖 이동(translate 100% · -full)만으로 숨긴 요소는 Tab 순서에 남아 보이지 않는
// 곳에 초점이 간다(aria-hidden 속 초점 = 접근성 위반). 이름을 박은 다섯 자리가 아니라 앱 전체의 그 «모양»을 전수로 모아, 자리마다
// 둘 중 하나를 반드시 쓰게 잠근다(PO 04:24Z):
//   ⓐ 닫힌 서랍 — `closedDrawerProps(progress)`(aria-hidden + inert · 닫히면 초점 · 클릭에서 빠짐)
//   ⓑ 늘 닿아야 하는 막대(스크롤로 숨는 상단바 · 도구막대) — 같은 클래스 줄에 `focus-within:translate-…-0`(초점이 들어오면 다시 보임)
// 새로 생기는 여섯째 자리도 이 가드에 걸린다. 도달 0인 자리만 이유와 함께 EXCEPTIONS에 둔다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { closedDrawerProps } from './use-swipe-drawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 웹 앱 소스 전체. `ee/apps/web/src`는 빌드 밖 옛 사본이라(apps/web/Dockerfile은 apps/web만 빌드 · tsconfig @ee/*는 ee/packages만) 훑지 않는다.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// 화면 밖 이동 모양 — 클래스(-translate-x-full · translate-y-full · -translate-y-[calc(100%+…)] 등)와 인라인 style(translateX(-100%) ·
// translateX(${(p - 1) * 100}%) 등). 스위치 손잡이(translate-x-[14px]) · 끌기(translate3d(px)) · 가운데 맞춤(-translate-x-1/2)은 100%가
// 아니라 부류 밖.
const CLASS_SHAPE = /(^|[\s'"`])-?translate-[xy]-(full|\[[^\]\s]*100%[^\]\s]*\])/;
const STYLE_SHAPE = /translate[XY]\(.*100.*%/; // 인자 안에 괄호가 올 수 있어(`(p - 1) * 100`) 같은 줄 전체로 본다
// [까디르 4653 P2] 폭만큼 음수 위치로 밀어 내는 모양(데스크톱 오프캔버스 사이드바 `left-[calc(var(--sidebar-width)*-1)]` 등). 몇 px짜리
// 장식 오프셋(`-left-[19px]` 점 · 손잡이)은 부류 밖.
const OFFSET_SHAPE = /(?:^|[\s'"`:])-(?:left|right|top|bottom)-(?:full|\[100%\])|(?:left|right|top|bottom)-\[calc\([^\]]*\*\s*-1\)\]/;
const REVEAL_ON_FOCUS = /focus-within:-?translate-[xy]-0/;
const DRAWER_HELPER = /closedDrawerProps\(/;
// 오프캔버스는 같은 요소의 명시 inert 식, 또는 내용 칸에 inert를 내려 주는 컨텍스트(사이드바 — 레일은 살려야 해서 컨테이너 통째 inert 금지).
const INERT_ATTR = /\binert=\{|OffcanvasHiddenContext\.Provider/;
const ELEMENT_WINDOW = 15; // 같은 JSX 요소의 속성 범위(줄)

/** 도달 0인 자리만 — `상대경로:줄 내용 일부` → 이유. 지금은 0개. */
const EXCEPTIONS: Record<string, string> = {};

export interface OffscreenSite { file: string; line: number; text: string; kind: 'class' | 'style' | 'offset' }

export function findUnguardedOffscreen(file: string, src: string): OffscreenSite[] {
  const lines = src.split('\n');
  const out: OffscreenSite[] = [];
  lines.forEach((text, i) => {
    const kind = CLASS_SHAPE.test(text) ? 'class' : STYLE_SHAPE.test(text) ? 'style' : OFFSET_SHAPE.test(text) ? 'offset' : null;
    if (!kind) return;
    const windowText = lines.slice(Math.max(0, i - ELEMENT_WINDOW), i + ELEMENT_WINDOW + 1).join('\n');
    // 오프캔버스(offset)는 같은 요소의 명시 inert 식도 처방으로 인정한다(사이드바처럼 서랍 훅이 아닌 자리).
    const guarded = (kind === 'class' && REVEAL_ON_FOCUS.test(text)) || DRAWER_HELPER.test(windowText) || (kind === 'offset' && INERT_ATTR.test(windowText));
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

const ALL = walk(SRC).map((p) => ({ file: relative(SRC, p), src: readFileSync(p, 'utf8') }));

describe('화면 밖으로 밀어 숨기기 — 종류 가드([SID:4288])', () => {
  it('훑는 범위가 비어 있지 않다(웹 앱 소스 전체)', () => {
    expect(ALL.length).toBeGreaterThan(500);
  });

  it('앱 전체에서 화면 밖 이동 자리마다 닫힌 서랍 헬퍼(inert) 또는 focus-within 드러내기를 쓴다', () => {
    const bad = ALL.flatMap(({ file, src }) => findUnguardedOffscreen(file, src));
    expect(bad, bad.map((b) => `${b.file}:${b.line} ${b.text}`).join('\n')).toEqual([]);
  });

  it('지금 잡히는 자리 전수(새 자리가 생기면 이 목록이 늘어난다 — 확인용)', () => {
    const sites = ALL.flatMap(({ file, src }) => src.split('\n').flatMap((t, i) => (CLASS_SHAPE.test(t) || STYLE_SHAPE.test(t) || OFFSET_SHAPE.test(t) ? [`${file}:${i + 1}`] : [])));
    expect(sites.map((s) => s.replace(/:\d+$/, '')).sort()).toEqual([
      'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
      'app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx',
      'components/docs/doc-editor.tsx',
      'components/nav/top-bar.tsx',
      'components/storage/storage-view.tsx',
      'components/ui/sidebar.tsx',
    ]);
  });

  it.each([
    ['components/storage/storage-view.tsx', /\{\.\.\.closedDrawerProps\(folderDrawerProgress, folderDrawerOpen\)\}/, 'aria-hidden={folderDrawerProgress === 0}'],
    ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', /\{\.\.\.closedDrawerProps\(drawerProgress, treeDrawerOpen\)\}/, 'aria-hidden={drawerProgress === 0}'],
    ['components/nav/top-bar.tsx', / focus-within:translate-y-0/, ''],
    ['components/docs/doc-editor.tsx', / focus-within:translate-y-0 focus-within:pointer-events-auto/, ''],
    ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx', / focus-within:translate-y-0/, ''],
    ['components/ui/sidebar.tsx', /SidebarOffcanvasHiddenContext\.Provider/g, 'React.Fragment'],
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
    // 폭만큼 음수 위치(오프캔버스)는 잡고, 몇 px 장식 오프셋은 안 잡는다.
    expect(probe('className="absolute -left-[19px] top-2 size-2"')).toBe(0);
    expect(probe('className="-right-[22px] top-1/2"')).toBe(0);
    expect(probe('"data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"')).toBe(1);
    expect(probe("hidden && '-left-full'")).toBe(1);
  });
});

describe('closedDrawerProps — React 19.2 불리언 inert가 실제 DOM 속성으로([SID:4288])', () => {
  // [유나 design 4653 회귀] 여는 렌더(isOpen 참 · progress 아직 0)에 inert가 남으면 초점 가두기의 focus()가 실패한다 → 둘째 행이 그 상태.
  it.each([
    [0, false, true], [0, true, false], [0.4, false, false], [1, false, false], [1, true, false],
  ] as const)('progress %s · isOpen %s → 닫힘(inert · aria-hidden) %s', async (progress, isOpen, closed) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<div data-testid="d" {...closedDrawerProps(progress, isOpen)}><button type="button">x</button></div>); });
    const el = host.querySelector('[data-testid="d"]')!;
    expect(el.hasAttribute('inert')).toBe(closed);
    expect(el.getAttribute('aria-hidden')).toBe(String(closed));
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
