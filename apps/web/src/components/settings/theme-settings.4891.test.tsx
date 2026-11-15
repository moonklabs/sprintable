// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 화면 · piece ③) — the theme card on ds parts: the same three choices and the same `setTheme`; the «following the system» line only while the choice is «system».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { themeState, setTheme } = vi.hoisted(() => ({ themeState: { theme: 'light' as string | undefined, systemTheme: 'dark' as string | undefined }, setTheme: vi.fn() }));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: themeState.theme, setTheme, systemTheme: themeState.systemTheme }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { setTheme.mockReset(); themeState.theme = 'light'; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function draw() {
  const { ThemeSettings } = await import('./theme-settings');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ThemeSettings /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const select = () => container.querySelector('select') as HTMLSelectElement;
const t = koMessages.settings;

describe('[SID:4891] ThemeSettings on ds parts', () => {
  it('is a ds card with the title as h2 and a real <label for> naming the select; the three choices are light · dark · system, the current one chosen', async () => {
    themeState.theme = 'dark';
    await draw();
    expect(container.querySelector('[data-slot="ds-card"] h2')?.textContent).toBe(t.themeSettingsTitle);
    expect(container.querySelector(`label[for="${select().id}"]`)?.textContent).toBe(t.themeSelectLabel);
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([['light', t.themeLight], ['dark', t.themeDark], ['system', t.themeSystem]]);
    expect(select().value).toBe('dark');
  });

  it('before the theme is known (`theme` undefined) the select shows «system» (the fallback), and nothing is drawn until the card has mounted', async () => {
    themeState.theme = undefined;
    const { ThemeSettings } = await import('./theme-settings');
    // a server render never runs effects = the pre-mount render: nothing is drawn (the hydration guard — the theme is only known in the browser)
    const html = renderToString(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ThemeSettings /></NextIntlClientProvider>);
    expect(html).not.toContain('<select');
    expect(html).toBe('');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ThemeSettings /></NextIntlClientProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(select().value).toBe('system');
  });

  it('choosing a value calls setTheme with exactly that value', async () => {
    await draw();
    for (const v of ['dark', 'system', 'light']) {
      await act(async () => { select().value = v; select().dispatchEvent(new Event('change', { bubbles: true })); });
      expect(setTheme).toHaveBeenLastCalledWith(v);
    }
  });

  it('«following the system» names the system\'s theme only while the choice is «system»', async () => {
    themeState.theme = 'system'; themeState.systemTheme = 'dark';
    await draw();
    expect(container.textContent).toContain(t.themeCurrentSystemLabel);
    expect(container.querySelector('span.font-medium')?.textContent).toBe(t.themeDark);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    themeState.theme = 'light';
    await draw();
    expect(container.textContent).not.toContain(t.themeCurrentSystemLabel);
  });
});
