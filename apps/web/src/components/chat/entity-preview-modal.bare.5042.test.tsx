// @vitest-environment jsdom
// story 5042 (C9) — the desktop app's work panel draws the reading view BARE: no close button (the panel has nothing to close) and no footer link out (a link out of the panel's one page has nowhere to go there).
// The chat's reading panel and modal (bare off) keep both, exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityPreviewModal } from './embed-card';
import koMessages from '../../../messages/ko.json';

let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function show(props: { bare?: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 'g-1', status: 'pending', gate_type: 'merge', risk_grade: 'high', work_item_summary: { title: 'PR 병합 게이트', slug: null }, work_item_id: 'wi-1' }) })));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><EntityPreviewModal entityType="gate" entityId="g-1" title={null} status={null} href={null} onClose={() => {}} embedded {...props} /></NextIntlClientProvider>);
  });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}
const closeButton = () => container.querySelector(`button[aria-label="${koMessages.common.close}"]`);
const footer = () => container.querySelector('div.border-t');

describe('[SID:5042] EntityPreviewModal bare (the work panel)', () => {
  it('⭐bare: the reading view without a close button and without the footer link — the body is still there', async () => {
    await show({ bare: true });
    expect(container.textContent).toContain('PR 병합 게이트');
    expect(closeButton()).toBeNull();
    expect(footer()).toBeNull();
  });
  it('⭐not bare (the chat\'s panel · the modal): the close button and the footer stay as they were', async () => {
    await show({});
    expect(closeButton()).not.toBeNull();
    expect(footer()).not.toBeNull();
  });
});
