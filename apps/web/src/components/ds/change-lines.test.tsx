// @vitest-environment jsdom
// story 4949 — ChangeLines: the rows of a change, never colour alone (a mark and a screen-reader word on every row), lines wrap, the empty line keeps its height.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChangeLines, type ChangeRow } from './change-lines';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const WORDS = { add: '추가', del: '삭제' };
async function show(rows: ChangeRow[]) { await act(async () => { root.render(<ChangeLines rows={rows} label="바꾸려는 줄" words={WORDS} />); }); }
const rowEls = () => [...container.querySelectorAll('[data-row]')] as HTMLElement[];

describe('ChangeLines (story 4949)', () => {
  it('⭐one row per line: a mark («+» · «−») for the eye and a screen-reader word — the tint is never the only sign', async () => {
    await show([{ kind: 'del', text: 'const a = 1;' }, { kind: 'add', text: 'const a = 2;' }]);
    const [del, add] = rowEls();
    expect([del!.dataset.row, add!.dataset.row]).toEqual(['del', 'add']);
    expect(del!.querySelector('[aria-hidden="true"]')!.textContent).toBe('−');
    expect(add!.querySelector('[aria-hidden="true"]')!.textContent).toBe('+');
    expect(del!.querySelector('.sr-only')!.textContent).toBe('삭제: ');
    expect(add!.querySelector('.sr-only')!.textContent).toBe('추가: ');
    expect(del!.className).toContain('bg-ds-failed-soft');
    expect(add!.className).toContain('bg-ds-done-soft');
  });

  it('the group is named, and the text is data (monospace) that wraps — a phone does not scroll a line sideways', async () => {
    await show([{ kind: 'add', text: 'x'.repeat(80) }]);
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('바꾸려는 줄');
    const text = rowEls()[0]!.querySelector('span.min-w-0')!;
    expect(text.className).toContain('whitespace-pre-wrap');
    expect(text.className).toContain('break-all');
    expect(rowEls()[0]!.className).toContain('font-mono');
  });

  it('a note row is plain text (no mark, no tint) and an empty line keeps its height', async () => {
    await show([{ kind: 'add', text: '' }, { kind: 'note', text: '…6줄 더' }]);
    const [empty, note] = rowEls();
    expect(empty!.querySelector('span.min-w-0')!.textContent).toBe(' ');
    expect(note!.dataset.row).toBe('note');
    expect(note!.textContent).toBe('…6줄 더');
    expect(note!.querySelector('[aria-hidden]')).toBeNull();
    expect(note!.className).not.toMatch(/bg-ds-(done|failed)-soft/);
  });

  it('indentation is kept (the text is rendered as pre-wrapped)', async () => {
    await show([{ kind: 'add', text: '    indented' }]);
    expect(rowEls()[0]!.querySelector('span.min-w-0')!.textContent).toBe('    indented');
  });
});
