// @vitest-environment jsdom
// story 4909 (UI-R1 AC3) — the «list + detail» width rule is ONE place: ≥ 1024px = beside, below = sheet.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useListDetailWide } from './use-list-detail-wide';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function Probe() { return <span data-testid="w">{String(useListDetailWide())}</span>; }
async function show(matches: boolean, queries: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => { queries.push(q); return { matches, media: q, addEventListener: () => {}, removeEventListener: () => {} }; });
  const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => { root!.render(<Probe />); });
  return document.body.querySelector('[data-testid="w"]')!.textContent;
}

describe('useListDetailWide', () => {
  it('⭐asks for ≥ 1024px and answers what the screen says', async () => {
    const queries: string[] = [];
    expect(await show(true, queries)).toBe('true');
    expect(queries).toContain('(min-width: 1024px)');
  });
  it('below it → false', async () => {
    expect(await show(false, [])).toBe('false');
  });
});
