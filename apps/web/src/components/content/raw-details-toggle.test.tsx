// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RawDetailsToggle } from './raw-details-toggle';

describe('RawDetailsToggle(story #3454)', () => {
  it('raw가 없으면(undefined) 아무것도 그리지 않는다', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RawDetailsToggle raw={undefined} label="서버 응답 보기" />);
    });
    expect(container.querySelector('details')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('raw가 있으면 접힌 상태로 뜨고, 펼치면 원문이 그대로 노출된다', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const raw = JSON.stringify({ code: 'X', message: 'y' });
    await act(async () => {
      root.render(<RawDetailsToggle raw={raw} label="서버 응답 보기" />);
    });
    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('summary')?.textContent).toBe('서버 응답 보기');
    expect(container.querySelector('pre')?.textContent).toBe(raw);
    await act(async () => { root.unmount(); });
  });
});
