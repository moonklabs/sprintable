// @vitest-environment jsdom
/**
 * story #4339 AC3 — 편집기에서 두 열 블록의 열이 **격자 칸**이 되어 나란히 선다.
 *
 * 예전: 격자(ColumnsBlockView `.grid`)와 열 사이에 NodeViewContent 두 겹(`.contents[data-node-view-content]` · Tiptap의
 * `[data-node-view-content-react]`)이 끼었고, 뒤 겹이 display 기본값이라 격자의 유일한 칸이 됐다 → 두 열이 첫 칸에 위아래로 쌓임
 * (실 브라우저 실측: 두 열 x 같음 · 폭 절반). jsdom은 배치를 못 재므로 **원인 불변식**을 잰다: 격자에서 각 열까지의 사이 요소가
 * 전부 `display: contents`(유틸리티 `contents` 클래스 또는 globals.css의 `display: contents` 규칙과 실제로 맞음)여야 열이 격자 칸이 된다.
 * 실 브라우저 배치(두 열 x 다름)는 PR 본문 실측 + 배포 뒤 PO 라이브(AC4).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import koMessages from '../../../messages/ko.json';
import { ColumnsBlock, ColumnBlock } from './extensions/column-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GLOBALS_CSS = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');

/** `display: contents`를 선언하는 규칙의 선택자(쉼표로 나뉜 것 각각). */
export function displayContentsSelectors(css: string): string[] {
  const out: string[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/display\s*:\s*contents/.test(m[2]!)) out.push(...m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** 격자 요소에서 열까지의 사이 요소 중 display: contents가 아닌 것. */
export function blockingWrappers(column: HTMLElement, grid: HTMLElement, selectors: string[]): string[] {
  const blocking: string[] = [];
  for (let el = column.parentElement; el && el !== grid; el = el.parentElement) {
    const isContents = el.classList.contains('contents') || selectors.some((sel) => { try { return el!.matches(sel); } catch { return false; } });
    if (!isContents) blocking.push(`${el.tagName.toLowerCase()}${[...el.attributes].map((a) => `[${a.name}]`).join('')}`);
  }
  return blocking;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  container?.remove();
  root = null; container = null;
});

async function renderColumns(html: string): Promise<HTMLElement> {
  function Harness() {
    const editor = useEditor({ immediatelyRender: true, extensions: [StarterKit.configure({ codeBlock: false }), ColumnsBlock, ColumnBlock], content: html });
    return <EditorContent editor={editor} />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness /></NextIntlClientProvider>);
  });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

const TWO_COLUMNS = '<div data-type="columnsBlock" data-cols="2"><div data-type="columnBlock"><p>왼쪽 단</p></div><div data-type="columnBlock"><p>오른쪽 단</p></div></div>';

describe('편집기 두 열 블록 배치(story #4339 AC3)', () => {
  it('⭐열마다 격자까지의 사이 요소가 전부 display: contents — 열이 격자 칸이 된다(두 열이 나란히)', async () => {
    const c = await renderColumns(TWO_COLUMNS);
    const grid = c.querySelector<HTMLElement>('.node-columnsBlock .grid');
    const columns = [...c.querySelectorAll<HTMLElement>('[data-type="columnBlock"]')];
    expect(grid, '격자').not.toBeNull();
    expect(columns.map((col) => col.textContent)).toEqual(['왼쪽 단', '오른쪽 단']);
    const selectors = displayContentsSelectors(GLOBALS_CSS);
    for (const col of columns) expect(blockingWrappers(col, grid!, selectors), col.textContent ?? '').toEqual([]);
  });

  it('양성 대조 — globals.css의 NodeView 겹 규칙이 없으면 Tiptap의 내용 겹이 격자 칸을 막는다(예전 모양)', async () => {
    const c = await renderColumns(TWO_COLUMNS);
    const grid = c.querySelector<HTMLElement>('.node-columnsBlock .grid')!;
    const col = c.querySelector<HTMLElement>('[data-type="columnBlock"]')!;
    const without = displayContentsSelectors(GLOBALS_CSS).filter((s) => !s.includes('data-node-view-content-react'));
    expect(blockingWrappers(col, grid, without)).toEqual(['div[data-node-view-content-react][data-node-view-wrapper][style]']);
  });

  it('규칙 읽기 — 주석 · 쉼표 · 다른 선언과 섞여도 display: contents 선택자만', () => {
    expect(displayContentsSelectors('/* .x { display: contents } */ .a, .b > .c { color: red; display: contents } .d { display: grid }')).toEqual(['.a', '.b > .c']);
  });
});
