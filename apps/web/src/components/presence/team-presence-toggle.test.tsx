// @vitest-environment jsdom
//
// story #3431(공용, PO 確定 2026-09-05) — PresenceToggleButton은 지금까지 전용 테스트가
// 없었다. 공용 배지(ds CountBadge) 도입 후에도 working-count 배지가 그대로 서는지 고정한다.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PresenceToggleButton, TeamPresenceToggleProvider } from './team-presence-toggle';

function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, node };
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('PresenceToggleButton — working-count 배지(story #3431 · 4890 ds CountBadge)', () => {
  it('provider 밖이면 미렌더', async () => {
    const { container, root } = mount(null);
    await act(async () => { root.render(wrap(<PresenceToggleButton />)); });
    expect(container.querySelector('button')).toBeNull();
  });

  it('workingCount=0이면 배지 자체가 안 뜬다', async () => {
    const { container, root } = mount(null);
    await act(async () => {
      root.render(wrap(
        <TeamPresenceToggleProvider value={{ toggle: () => {}, workingCount: 0, open: false }}>
          <PresenceToggleButton />
        </TeamPresenceToggleProvider>,
      ));
    });
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('workingCount>0 — ds CountBadge(읽지 않음 꼴 · 숨김)가 뜬다', async () => {
    const { container, root } = mount(null);
    await act(async () => {
      root.render(wrap(
        <TeamPresenceToggleProvider value={{ toggle: () => {}, workingCount: 4, open: false }}>
          <PresenceToggleButton />
        </TeamPresenceToggleProvider>,
      ));
    });
    const badge = container.querySelector('[data-slot="ds-count-badge"]');
    expect(badge?.textContent).toBe('4');
    expect(badge?.getAttribute('aria-hidden')).toBe('true'); // the count is told by the button's own name (fabLabelWorking)
    expect(badge?.className).not.toContain('text-micro');
  });
});
