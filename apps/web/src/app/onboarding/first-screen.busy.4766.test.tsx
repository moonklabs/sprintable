// @vitest-environment jsdom
// story 4766 (codex rounds 1–2) — while the web way's press is making the agent and its key, the screen's other way out («오늘로 가기») waits:
// leaving then would leave an agent and a key with no screen left to revoke them. Reverting `onWorking={setAdvancedBusy}` or `disabled={advancedBusy}`
// in first-screen.tsx turns this red (the AdvancedConnect side is pinned in advanced-connect.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('./advanced-connect', () => ({
  AdvancedConnect: ({ onWorking }: { onWorking?: (w: boolean) => void }) => (
    <div>
      <button data-testid="stub-start" onClick={() => onWorking?.(true)} />
      <button data-testid="stub-stop" onClick={() => onWorking?.(false)} />
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FirstScreen } = await import('./first-screen');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) })));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;

describe('FirstScreen — the way out waits while the web way is making things (story 4766)', () => {
  it('disabled (and onFinish not called) while working; free again after', async () => {
    const onFinish = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <FirstScreen orgId="org-1" chatsHref="/chats" orgName={null} onFinish={onFinish} />
        </NextIntlClientProvider>,
      );
    });
    const finish = () => container.querySelectorAll('[data-testid="onboarding-first-finish"]');
    expect(finish().length).toBeGreaterThan(0);
    await act(async () => { q('stub-start')!.click(); });
    for (const b of finish()) expect((b as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (finish()[0] as HTMLButtonElement).click(); });
    expect(onFinish).not.toHaveBeenCalled();
    await act(async () => { q('stub-stop')!.click(); });
    for (const b of finish()) expect((b as HTMLButtonElement).disabled).toBe(false);
  });
});
