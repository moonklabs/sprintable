// @vitest-environment jsdom
// story 4909 (UI-R1 AC3) — the generic «which row does the detail show» rule (the home's rule, for any list): first open = the first row to act on; a picked row stays; when it leaves,
// the next row IN THE SAME SECTION is picked (never a jump to another section); a new array with the same rows does not re-decide.
import { afterEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { selectNextAfterLeft, useListSelection, type SelectableRow } from './use-list-selection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.innerHTML = ''; });

const rows = (...keys: string[]): SelectableRow[] => keys.map((key) => ({ key }));
let api: ReturnType<typeof useListSelection>;
let renders = 0;
// `onRender` counts the render passes from OUTSIDE the component (the callback is built in the test, so the component never reassigns an outer variable while rendering)
function Probe({ sections, initial, onRender }: { sections: SelectableRow[][]; initial: string | null; onRender: () => void }) {
  const a = useListSelection(sections, initial);
  onRender();
  useEffect(() => { api = a; });
  return <span data-testid="k">{a.selectedKey ?? 'none'}</span>;
}
const key = () => document.body.querySelector('[data-testid="k"]')!.textContent;
async function show(sections: SelectableRow[][], initial: string | null) {
  if (!root) { const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); }
  await act(async () => { root!.render(<Probe sections={sections} initial={initial} onRender={() => { renders += 1; }} />); });
}

describe('selectNextAfterLeft', () => {
  it('the row now where it was · else the last · else nothing · unknown key → the first', () => {
    expect(selectNextAfterLeft(rows('a', 'b', 'c'), 'b')).toBe('c');
    expect(selectNextAfterLeft(rows('a', 'b', 'c'), 'c')).toBe('b');
    expect(selectNextAfterLeft(rows('a'), 'a')).toBeNull();
    expect(selectNextAfterLeft(rows('a', 'b'), 'zzz')).toBe('a');
  });
});

describe('useListSelection', () => {
  it('⭐first open = the initial key', async () => {
    await show([rows('a', 'b'), rows('w1')], 'a');
    expect(key()).toBe('a');
  });

  it('a picked row stays picked while it is still in the list (the others change around it)', async () => {
    await show([rows('a', 'b', 'c')], 'a');
    await act(async () => { api.select('c'); });
    await show([rows('b', 'c', 'd')], 'b');
    expect(key()).toBe('c');
  });

  it('⭐a picked row that leaves → the next row IN THE SAME SECTION (not the first row of the first section)', async () => {
    await show([rows('a', 'b'), rows('h1', 'h2', 'h3')], 'a');
    await act(async () => { api.select('h2'); });
    await show([rows('a', 'b'), rows('h1', 'h3')], 'a'); // h2 left → h3 sits where it was
    expect(key()).toBe('h3');
  });

  it('the last row of a section leaves → the one before it; the whole section empties → the initial key', async () => {
    await show([rows('a'), rows('d1', 'd2')], 'a');
    await act(async () => { api.select('d2'); });
    await show([rows('a'), rows('d1')], 'a');
    expect(key()).toBe('d1');
    await show([rows('a'), rows()], 'a');
    expect(key()).toBe('a');
  });

  it('nothing picked and rows arrive → the initial key; every row gone → none', async () => {
    await show([rows()], null);
    expect(key()).toBe('none');
    await show([rows('a', 'b')], 'a');
    expect(key()).toBe('a');
    await show([rows()], null);
    expect(key()).toBe('none');
  });

  it('⭐a NEW array with the SAME rows does not re-decide (no extra render pass, the pick is untouched)', async () => {
    await show([rows('a', 'b', 'c')], 'a');
    await act(async () => { api.select('b'); });
    renders = 0;
    await show([rows('a', 'b', 'c')], 'a'); // a fresh array every call
    expect(key()).toBe('b');
    expect(renders).toBe(1); // one render for the new props — a re-decide would add a second pass
  });
});
