// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › notifications) — the rebuilt pane: what it draws and which press calls which handler. (The pixel rules — every press ≥ 44, no text under 12 px, rows ≥ 56 — are measured in Chromium by
// e2e/notifications-pane.4891.layout.spec.ts; jsdom has no layout.) Each test names the line that, reverted, turns it red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { NotificationsPane, type NotificationsPaneProps } from './notifications-pane';

vi.mock('@/components/settings/push-register-notice', () => ({ PushRegisterNotice: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATEGORIES = [
  { key: 'story', types: ['story', 'story_assigned'] },
  { key: 'task', types: ['task', 'task_assigned'] },
] as const;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function props(over: Partial<NotificationsPaneProps> = {}): NotificationsPaneProps {
  return {
    loading: false, categories: CATEGORIES, globalLevel: 'all', savingLevel: false, onSetLevel: vi.fn(),
    getEnabled: (e) => e !== 'task_assigned', onToggle: vi.fn(), isCategoryAllEnabled: (k) => k === 'story', onToggleCategory: vi.fn(), showSoonColumns: false, ...over,
  };
}
async function draw(p: NotificationsPaneProps) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationsPane {...p} /></NextIntlClientProvider>); });
}
const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); };
const buttonByText = (text: string, within: ParentNode = container) => [...within.querySelectorAll('button')].find((b) => b.textContent === text);

describe('[SID:4891] NotificationsPane', () => {
  it('draws a heading per category and one ds list row per event, each with a switch named «event + 앱 내» and its on / off', async () => {
    await draw(props());
    expect([...container.querySelectorAll('[data-slot="ds-section-header"]')]).toHaveLength(2);
    const rows = [...container.querySelectorAll('[data-slot="ds-list-row"]')];
    expect(rows).toHaveLength(4);
    const sw = [...container.querySelectorAll('[role="switch"]')];
    expect(sw.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false']);
    // reverted (the switch without aria-labelledby = event + column head) → names empty
    const names = sw.map((s) => s.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)?.textContent?.trim() ?? '∅').join(' '));
    expect(names[3]).toBe(`${koMessages.settings.event_task_assigned} ${koMessages.settings.notification_channel_in_app}`);
    expect(names.some((n) => n.includes('∅'))).toBe(false);
  });

  it('a switch calls onToggle(event, its current value); a category button calls onToggleCategory(key, the opposite of «all on»)', async () => {
    const p = props();
    await draw(p);
    await press(container.querySelectorAll('[role="switch"]')[3]);
    expect(p.onToggle).toHaveBeenCalledWith('task_assigned', false);
    await press(buttonByText(koMessages.common.disable_all, container.querySelector('[data-testid="notifications-category-story"]')!));
    expect(p.onToggleCategory).toHaveBeenCalledWith('story', false);
    await press(buttonByText(koMessages.common.enable_all, container.querySelector('[data-testid="notifications-category-task"]')!));
    expect(p.onToggleCategory).toHaveBeenCalledWith('task', true);
  });

  it('the default level is one of three: the chosen one is aria-pressed, a press calls onSetLevel, and all three are held while a save is out', async () => {
    const p = props({ globalLevel: 'mentions' });
    await draw(p);
    const level = (l: string) => buttonByText(l, container.querySelector('[data-testid="notifications-default-level"]')!)!;
    expect(level(koMessages.settings.notificationLevel_mentions).getAttribute('aria-pressed')).toBe('true');
    expect(level(koMessages.settings.notificationLevel_all).getAttribute('aria-pressed')).toBe('false');
    await press(level(koMessages.settings.notificationLevel_mute));
    expect(p.onSetLevel).toHaveBeenCalledWith('mute');
    await draw(props({ savingLevel: true }));
    expect([...container.querySelectorAll('[data-testid="notifications-default-level"] button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('loading draws the skeleton and none of the controls', async () => {
    await draw(props({ loading: true }));
    expect(container.querySelector('[data-testid="notifications-pane-loading"]')).not.toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it('the «coming soon» columns are for a desktop width only: drawn hidden-below-lg when the build has them, not drawn when it does not', async () => {
    await draw(props({ showSoonColumns: true }));
    const soon = [...container.querySelectorAll('span')].filter((s) => s.textContent === koMessages.settings.notification_coming_soon);
    expect(soon.length).toBeGreaterThan(0);
    expect(soon.every((s) => s.className.includes('hidden') && s.className.includes('lg:block'))).toBe(true);
    await draw(props({ showSoonColumns: false }));
    expect([...container.querySelectorAll('span')].some((s) => s.textContent === koMessages.settings.notification_coming_soon)).toBe(false);
  });

  it('no text smaller than 12 px is written into the pane (no text-[11px] · no text-ds-mono-md in its own markup)', async () => {
    await draw(props({ showSoonColumns: true }));
    expect(container.innerHTML).not.toMatch(/text-\[(9|10|11)px\]/);
  });
});
