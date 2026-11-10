// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CountBadge } from './count-badge';

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
const el = () => container.querySelector('[data-slot="ds-count-badge"]') as HTMLElement;

describe('ds CountBadge', () => {
  it('⭐읽지 않음 = action · 결재 대기 = needs-hand-bar(+ 어두운 글) — 새 글은 «내 손 필요»가 아니다', async () => {
    await act(async () => { root.render(<CountBadge count={3} />); });
    expect(el().className).toContain('bg-ds-action');
    expect(el().className).not.toContain('needs-hand');
    await act(async () => { root.render(<CountBadge count={3} kind="needs-hand" label="결재 대기" />); });
    expect(el().className).toContain('bg-ds-needs-hand-bar');
    expect(el().className).toContain('text-ds-on-needs-hand');
  });

  it('수를 그대로 보이고 99를 넘으면 99+ · max로 바꾼다', async () => {
    await act(async () => { root.render(<CountBadge count={7} />); });
    expect(el().textContent).toBe('7');
    await act(async () => { root.render(<CountBadge count={100} />); });
    expect(el().textContent).toBe('99+');
    await act(async () => { root.render(<CountBadge count={12} max={9} />); });
    expect(el().textContent).toBe('9+');
  });

  it('⭐내 손 필요 배지는 화면에 안 보이는 이름을 함께 읽힌다(색만으로 뜻을 싣지 않는다)', async () => {
    await act(async () => { root.render(<CountBadge count={3} kind="needs-hand" label="결재 대기" />); });
    const cue = el().querySelector('.sr-only');
    expect(cue?.textContent).toContain('결재 대기');
    expect(el().textContent).toContain('3');
    await act(async () => { root.render(<CountBadge count={3} />); });
    expect(el().querySelector('.sr-only')).toBeNull();
  });

  it('⭐atLeast: 읽다 만 수는 «N+»로 그려 정확한 수처럼 보이지 않게 한다(기본은 정확한 수)', async () => {
    await act(async () => { root.render(<CountBadge kind="needs-hand" label="결재 대기" count={3} atLeast />); });
    expect(el().textContent).toContain('3+');
    await act(async () => { root.render(<CountBadge kind="needs-hand" label="결재 대기" count={3} />); });
    expect(el().textContent).not.toContain('+');
  });
});

