// @vitest-environment jsdom
//
// story #4014 AC3 — StatusChip이 어느 레이아웃(표·카드)에서도 세로로 안 쪼개진다.
// whitespace-nowrap을 지우면 이 단언이 RED.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StatusChip } from './status-chip';

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

describe('StatusChip', () => {
  it('⭐whitespace-nowrap이 클래스에 있다(칩 세로 쪼개짐 근절, story #4014 AC3)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => { root.render(wrap(<StatusChip status="approved" />)); });

    const chip = container.querySelector('[data-status-chip]');
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain('whitespace-nowrap');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
