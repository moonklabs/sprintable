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

async function show(props: { wide: boolean; sheetOpen?: boolean; onSheetOpenChange?: (o: boolean) => void; testId?: string; fill?: boolean }) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ListDetailShell
          list={<ul data-testid="the-list"><li>행 하나</li></ul>}
          detail={<div data-testid="the-detail">상세 내용</div>}
          wide={props.wide}
          detailLabel="상세 열"
          sheetLabel="상세 시트"
          sheetOpen={props.sheetOpen ?? false}
          onSheetOpenChange={props.onSheetOpenChange ?? (() => {})}
          testId={props.testId}
          fill={props.fill}
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
    expect(column().className).toBe('sticky top-4 max-h-[calc(100svh-6rem)]');
    await show({ wide: true, fill: false });
    expect(root_().className).toBe('lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4');
    expect(column().className).toBe('sticky top-4 max-h-[calc(100svh-6rem)]');
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
