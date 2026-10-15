// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · Yuna §I ①) — the one computer chip: the name as given, the spoken label «{name}에 연결됨», the full name
// in `title`; no name → nothing at all (an agent with no live desktop key · a human · an older server).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DeviceChip } from './device-chip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const mount = async (node: React.ReactNode) => {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
};

describe('[SID:4675] DeviceChip', () => {
  it('a name → the chip with the name, the aria «{name}에 연결됨», the full name as title', async () => {
    await mount(<DeviceChip name="yoonjae의 맥" />);
    const chip = container.querySelector('[data-testid=device-chip]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('yoonjae의 맥');
    expect(chip.getAttribute('aria-label')).toBe('yoonjae의 맥에 연결됨');
    expect(chip.getAttribute('title')).toBe('yoonjae의 맥');
    expect(chip.className).toContain('max-w-40'); // a long name is cut (the inner span truncates), never wrapped
  });

  it('no name (null · undefined · empty) → nothing drawn', async () => {
    await mount(<><DeviceChip name={null} /><DeviceChip name={undefined} /><DeviceChip name="" /></>);
    expect(container.querySelectorAll('[data-testid=device-chip]')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });
});
