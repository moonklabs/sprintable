// @vitest-environment jsdom
// story 4909 (UI-R1 AC3) — the shared «list + detail» skeleton. Wide: the list and the detail column are both on screen and no sheet exists. Narrow: the list alone, the detail only as an
// open sheet (never both). The sheet is named (aria-label + a screen-reader title) and asks the caller to close it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ListDetailShell } from './list-detail-shell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

async function show(props: { wide: boolean; sheetOpen?: boolean; onSheetOpenChange?: (o: boolean) => void; testId?: string; fill?: boolean; sheetHeader?: string; detailWidth?: 'flex' | 'fixed' }) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ListDetailShell
          list={<ul data-testid="the-list"><li>행 하나</li></ul>}
          detail={<div data-testid="the-detail">상세 내용</div>}
          wide={props.wide}
          detailLabel="상세 열"
          sheetLabel="상세 시트"
          sheetHeader={props.sheetHeader}
          sheetOpen={props.sheetOpen ?? false}
          onSheetOpenChange={props.onSheetOpenChange ?? (() => {})}
          testId={props.testId}
          fill={props.fill}
          detailWidth={props.detailWidth}
        />
      </NextIntlClientProvider>,
    );
  });
}

describe('ListDetailShell — the «frame gives the height» mode (story 4909 defect PR)', () => {
  const root_ = () => container.querySelector('[data-testid="list-detail"]') as HTMLElement;
  const column = () => container.querySelector('[data-testid="list-detail-detail-column"]') as HTMLElement;
  it('⭐OFF (the default): every screen that does not ask for it stands exactly as before — the page-scroll grid and the sticky, height-capped column', async () => {
    await show({ wide: true });
    expect(root_().className).toBe('lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4');
    expect(column().className).toBe('sticky top-4 max-h-[calc(100svh-6rem)] empty:hidden');
    await show({ wide: true, fill: false });
    expect(root_().className).toBe('lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4');
    expect(column().className).toBe('sticky top-4 max-h-[calc(100svh-6rem)] empty:hidden');
  });
  it('⭐ON: the row takes the frame\'s height (flex-1 · min-h-0 · one minmax(0,1fr) row), the column fills it — no sticky and no viewport-height guess', async () => {
    await show({ wide: true, fill: true });
    expect(root_().className).toContain('lg:flex-1');
    expect(root_().className).toContain('lg:min-h-0');
    expect(root_().className).toContain('lg:grid-rows-[minmax(0,1fr)]');
    expect(root_().className).toContain('lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]');
    expect(column().className).toContain('lg:h-full');
    expect(column().className).toContain('min-h-0');
    expect(root_().className + column().className).not.toMatch(/sticky|svh|calc\(/);
  });
  it('ON does not change narrow: the same named sheet', async () => {
    await show({ wide: false, sheetOpen: true, fill: true });
    expect(document.body.querySelector('[data-testid="list-detail-detail-sheet"]')?.getAttribute('aria-label')).toBe('상세 시트');
    expect(container.querySelector('[data-testid="list-detail-detail-column"]')).toBeNull();
  });
});

describe('ListDetailShell', () => {
  it('⭐wide: the list AND a named detail column are on screen; no sheet', async () => {
    await show({ wide: true });
    expect(container.querySelector('[data-testid="the-list"]')).toBeTruthy();
    const column = container.querySelector('[data-testid="list-detail-detail-column"]');
    expect(column?.getAttribute('aria-label')).toBe('상세 열');
    expect(column?.querySelector('[data-testid="the-detail"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="list-detail-detail-sheet"]')).toBeNull();
    expect(container.querySelector('[data-testid="list-detail"]')?.className).toContain('lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]');
  });

  it('⭐narrow + closed: the list alone — neither a column nor a sheet', async () => {
    await show({ wide: false, sheetOpen: false });
    expect(container.querySelector('[data-testid="the-list"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="list-detail-detail-column"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="the-detail"]')).toBeNull();
  });

  it('⭐narrow + open: the detail is a NAMED sheet (aria-label and a screen-reader title), and there is no wide column', async () => {
    await show({ wide: false, sheetOpen: true });
    const sheet = document.body.querySelector('[data-testid="list-detail-detail-sheet"]');
    expect(sheet).toBeTruthy();
    expect(sheet?.getAttribute('aria-label')).toBe('상세 시트');
    expect(sheet?.textContent).toContain('상세 시트'); // the sr-only title
    expect(sheet?.querySelector('[data-testid="the-detail"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="list-detail-detail-column"]')).toBeNull();
  });

  it('[4938] the narrow sheet\'s header row is never empty: the title is DRAWN (one line, not screen-reader-only) in the row that keeps the close button\'s place', async () => {
    await show({ wide: false, sheetOpen: true });
    const sheet = document.body.querySelector('[data-testid="list-detail-detail-sheet"]')!;
    const header = sheet.querySelector('[data-panel-header]') as HTMLElement;
    expect(header).not.toBeNull();
    const label = header.querySelector('[data-slot="sheet-header-label"]') as HTMLElement;
    expect(label.textContent).toBe('상세 열'); // the short generic label (detailLabel), never the long «{title} 자세히» the card under it already says
    expect(label.getAttribute('aria-hidden')).toBe('true');
    expect(label.className).toContain('truncate');
    expect(header.querySelector('.sr-only')?.textContent).toBe('상세 시트'); // the screen-reader title keeps the specific name
    expect(header.className).toContain('group-data-[close-button]/dialog:pr-9'); // the X's place stays reserved in this row
  });

  it('[4938] a screen whose card already says the generic word passes its own header text; the header row is as tall as the close button\'s place so label and X share a centre line', async () => {
    await show({ wide: false, sheetOpen: true, sheetHeader: '자세히' });
    const header = document.body.querySelector('[data-testid="list-detail-detail-sheet"] [data-panel-header]') as HTMLElement;
    expect((header.querySelector('[data-slot="sheet-header-label"]') as HTMLElement).textContent).toBe('자세히');
    expect(header.className).toContain('min-h-[3.75rem]');
    expect(header.className).toContain('justify-center');
  });

  it('the sheet asks the caller to close it (the close button)', async () => {
    const onChange = vi.fn();
    await show({ wide: false, sheetOpen: true, onSheetOpenChange: onChange });
    const close = [...document.body.querySelectorAll('[data-testid="list-detail-detail-sheet"] button')].find((b) => /닫기|close/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    expect(close).toBeTruthy();
    await act(async () => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]![0]).toBe(false); // (the second argument is the library's event detail)
  });

  it('explicit column / sheet ids win over the derived ones (the home keeps its own)', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ListDetailShell list={<i />} detail={<b />} wide detailLabel="상세 열" sheetLabel="상세 시트" sheetOpen={false} onSheetOpenChange={() => {}} testId="home-screen" columnTestId="home-detail-column" sheetTestId="home-detail-sheet" />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[data-testid="home-detail-column"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="home-screen-detail-column"]')).toBeNull();
  });

  it('the test ids follow the root id the caller gives', async () => {
    await show({ wide: true, testId: 'gates-screen' });
    expect(container.querySelector('[data-testid="gates-screen"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="gates-screen-detail-column"]')).toBeTruthy();
  });
});

// story 5031 (C1 step 5c · PO): the home's split — the DETAIL a fixed 340 and the list the rest. One optional prop; the default is the shape every other screen (the agents frame · the inbox tabs) has had, character for character.
describe('ListDetailShell — detailWidth (story 5031 · 5c)', () => {
  const root_ = () => container.querySelector('[data-testid="list-detail"]') as HTMLElement;
  const FLEX = 'lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]';
  const FIXED = 'lg:grid-cols-[minmax(0,1fr)_340px]';
  it('⭐the default (and `flex`) is the old grid in BOTH modes — not a character changed; `fixed` is the 340 split in both modes', async () => {
    for (const fill of [false, true]) {
      await show({ wide: true, fill });
      const old = fill
        ? 'lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-start lg:gap-4'
        : 'lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4';
      expect(root_().className, `default · fill ${fill}`).toBe(old);
      await show({ wide: true, fill, detailWidth: 'flex' });
      expect(root_().className, `flex · fill ${fill}`).toBe(old);
      await show({ wide: true, fill, detailWidth: 'fixed' });
      expect(root_().className, `fixed · fill ${fill}`).toBe(old.replace(FLEX, FIXED));
      expect(root_().className).not.toContain(FLEX);
    }
  });
  it('the detail column and the sheet are the same for both splits (only the wide grid changes)', async () => {
    await show({ wide: true, detailWidth: 'fixed' });
    expect((container.querySelector('[data-testid="list-detail-detail-column"]') as HTMLElement).className).toBe('sticky top-4 max-h-[calc(100svh-6rem)] empty:hidden');
    await show({ wide: false, sheetOpen: true, detailWidth: 'fixed' });
    expect(document.querySelector('[data-testid="list-detail-detail-sheet"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="list-detail-detail-column"]')).toBeNull();
  });

  it('⭐`fixed` with `wide` false is ONE column (a caller whose own threshold is above lg): no 340 track left empty; `flex` with `wide` false is the old grid as before', async () => {
    for (const fill of [false, true]) {
      await show({ wide: false, fill, detailWidth: 'fixed' });
      expect(root_().className, `fixed · not wide · fill ${fill}`).toContain('lg:grid-cols-[minmax(0,1fr)]');
      expect(root_().className).not.toContain('340px');
      expect(root_().className).not.toContain(FLEX);
      await show({ wide: false, fill });
      expect(root_().className, `default · not wide · fill ${fill}`).toContain(FLEX);
    }
  });
  it('the 340 written in the class and the gap 16 (`lg:gap-4`) are the named home numbers (home-layout.ts)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { HOME_DETAIL_W, HOME_GAP } = await import('@/components/home/home-layout');
    const src = readFileSync(path.join(__dirname, 'list-detail-shell.tsx'), 'utf8');
    expect(src).toContain(`_${HOME_DETAIL_W}px]`);
    expect(src).toContain(`lg:gap-${HOME_GAP / 4}`);
  });
});
