// UI-3(a9d56577) — ds ToastCard 회귀가드: 세 종의 역할 · 아이콘 · 단추.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }
import { ToastCard } from './toast-card';

const el = () => container.querySelector('[data-slot="ds-toast"]') as HTMLElement;

describe('ds ToastCard', () => {
  it('⭐오류는 role=alert · assertive, 정보 · 되돌리기는 role=status · polite', async () => {
    await render(<ToastCard kind="error" title="저장하지 못했어요" onDismiss={() => {}} />);
    expect(el().getAttribute('role')).toBe('alert');
    expect(el().getAttribute('aria-live')).toBe('assertive');
    expect(el().querySelector('[data-icon="error"]')).not.toBeNull();
    for (const kind of ['info', 'undo'] as const) {
      await render(<ToastCard kind={kind} title="글" onDismiss={() => {}} />);
      expect(el().getAttribute('role'), kind).toBe('status');
      expect(el().getAttribute('aria-live'), kind).toBe('polite');
    }
  });

  it('세 종이 서로 다른 모양(색만이 아니라 아이콘도 다르다)', async () => {
    const seen = new Set<string>();
    for (const [kind, icon] of [['info', 'info'], ['undo', 'undo'], ['error', 'error']] as const) {
      await render(<ToastCard kind={kind} title="글" onDismiss={() => {}} />);
      expect(el().querySelector(`[data-icon="${icon}"]`), kind).not.toBeNull();
      seen.add(el().className);
    }
    expect(seen.size).toBe(3);
  });

  it('보조 단추(되돌리기)와 닫기: 눌리면 각 콜백, 닫기 이름은 «닫기»', async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    await render(<ToastCard kind="undo" title="지웠어요" actionLabel="되돌리기" onAction={onAction} onDismiss={onDismiss} />);
    const buttons = [...el().querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['되돌리기', '닫기']);
    await act(async () => { buttons[0]!.click(); });
    await act(async () => { buttons[1]!.click(); });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('단추 이름이나 콜백 중 하나라도 없으면 보조 단추를 그리지 않는다', async () => {
    await render(<ToastCard title="글" actionLabel="되돌리기" onDismiss={() => {}} />);
    expect([...el().querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['닫기']);
  });
});
