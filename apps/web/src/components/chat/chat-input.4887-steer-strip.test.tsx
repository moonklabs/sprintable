// @vitest-environment jsdom
//
// story 4887 (UI-4 P5-b · AC3 «지시 대상 이름표 칩») — the steer panel (an info-coloured box: a title row, then the controls under it) is ONE chip strip: the «조종» chip, then the target and the work item on the same line.
// The same controls, the same data, the same `preset.steer.instruct` event (chat-input.test.tsx and chat-controls.4831.test.tsx lock the send and the pickers): only the place and the shape changed. jsdom draws no layout, so
// these pin the structure; e2e/chat-input-steer-strip.4887.layout.spec.ts measures it in Chromium.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatInput } from './chat-input';
import { invalidateOrgDomainLabels } from '@/hooks/use-org-domain-labels';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  invalidateOrgDomainLabels();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false } as MediaQueryList));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const chats = koMessages.chats;
async function render(participants: { member_id: string; name: string }[] = [{ member_id: 'me-1', name: '나' }, { member_id: 'a-1', name: '개발 에이전트' }, { member_id: 'a-2', name: '검수 에이전트' }]) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatInput onSend={async () => {}} threadId="t1" projectId="p1" currentTeamMemberId="me-1" participants={participants} /></NextIntlClientProvider>);
  });
}
const toggle = () => container.querySelector(`button[aria-label="${chats.steerToggleLabel}"]`) as HTMLButtonElement | null;
const strip = () => container.querySelector('[data-testid="steer-strip"]') as HTMLElement | null;
const open = async () => { await act(async () => { toggle()!.click(); }); };

describe('ChatInput — the steer chip strip (story 4887 · UI-4 P5-b)', () => {
  it('⭐ turning steer on draws ONE strip: a labelled group holding the «조종» chip, the target select and the work-item field', async () => {
    await render();
    expect(strip(), 'closed: no strip').toBeNull();
    await open();
    const s = strip()!;
    expect(s, 'open: the strip').not.toBeNull();
    expect(s.getAttribute('role')).toBe('group');
    expect(s.getAttribute('aria-label')).toBe(chats.steerPanelTitle);
    const chip = s.querySelector('[data-slot="ds-chip"]') as HTMLElement; // reverted (the old title row) → no chip
    expect(chip, 'the ds Chip').not.toBeNull();
    expect(chip.textContent).toContain(chats.steerPanelTitle);
    expect(s.querySelector(`select[aria-label="${chats.steerPanelTargetLabel}"]`), 'the target select, same name').not.toBeNull();
    expect(s.querySelector(`input[aria-label="${chats.steerPanelWorkItemLabel}"]`), 'the work-item field, same name').not.toBeNull();
  });

  it('⭐ no info-coloured box and no separate title row: the title is said ONCE, by the chip', async () => {
    await render(); await open();
    const s = strip()!;
    for (const c of ['border-info', 'bg-info', 'rounded-lg', 'space-y-1.5']) expect(s.className, `the strip has no «${c}» box class`).not.toContain(c); // reverted (the old panel box) → fails
    // the two controls carry the ds control boundary and face (a plain border-input is ~1.2:1 against the page — below the 3:1 non-text minimum)
    for (const el of [s.querySelector('select')!, s.querySelector('input')!]) {
      expect(el.className, 'the ds control boundary').toContain('border-ds-line-control'); // reverted → border-input
      expect(el.className, 'the ds control face').toContain('bg-ds-surface-sunk');
      expect(el.className, 'the ds face in DARK too (the base Input/Select carry dark:bg-input/30, which would win)').toContain('dark:bg-ds-surface-sunk'); // reverted → the legacy translucent fill in dark
    }
    const own = (e: Element) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim(); // an element's OWN text (the chip also holds an icon)
    const titled = [...s.querySelectorAll('*')].filter((e) => own(e) === chats.steerPanelTitle);
    expect(titled, 'the title text appears exactly once').toHaveLength(1);
    // …and a screen reader hears it once too: the group's accessible name says it, so the visible chip is hidden from assistive tech
    expect(s.getAttribute('aria-label')).toBe(chats.steerPanelTitle);
    expect((s.querySelector('[data-slot="ds-chip"]') as HTMLElement).getAttribute('aria-hidden'), 'the chip repeats the group name: hidden from assistive tech').toBe('true'); // reverted → null
  });

  it('the data is unchanged: the target list is the OTHER participants (never me) behind a placeholder; the work-item field is the same input', async () => {
    await render(); await open();
    const select = strip()!.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([chats.steerPanelTargetPlaceholder, '개발 에이전트', '검수 에이전트']);
    const input = strip()!.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe(chats.steerPanelWorkItemPlaceholder);
  });

  it('the compass toggle still opens and closes it (aria-pressed follows) — and is not even offered when I am the only participant', async () => {
    await render();
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    await open();
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    await open();
    expect(strip()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render([{ member_id: 'me-1', name: '나' }]);
    expect(toggle(), 'nobody to steer → no toggle (a dead button is not drawn)').toBeNull();
  });
});
