// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SectionHeader } from './section-header';

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

describe('ds SectionHeader', () => {
  it('접히지 않는 머리글에는 단추가 없다', async () => {
    await act(async () => { root.render(<SectionHeader title="일하는 중" />); });
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('h3')!.textContent).toBe('일하는 중');
  });

  it('⭐접히는 머리글: 단추 · aria-expanded가 접힘과 반대 · 누르면 onToggle', async () => {
    const onToggle = vi.fn();
    await act(async () => { root.render(<SectionHeader title="끝남" collapsed={false} onToggle={onToggle} />); });
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(b.querySelector('[data-icon="expand_more"]')).not.toBeNull();
    await act(async () => { b.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<SectionHeader title="끝남" collapsed onToggle={onToggle} />); });
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-icon="chevron_right"]')).not.toBeNull();
  });

  it('⭐손 필요 구역: touch_app 아이콘 + 제목 needs-hand(색만으로 말하지 않는다)', async () => {
    await act(async () => { root.render(<SectionHeader title="내 손이 필요해요" tone="needs-hand" />); });
    expect(container.querySelector('[data-icon="touch_app"]')).not.toBeNull();
    expect(container.querySelector('.text-ds-needs-hand')).not.toBeNull();
  });

  it('건수 · 오른쪽 보조 · 머리글 단계', async () => {
    await act(async () => { root.render(<SectionHeader title="구역" count={<span data-testid="c">3</span>} trailing="오래 기다린 순" level={2} />); });
    expect(container.querySelector('h2')).not.toBeNull();
    expect(container.querySelector('[data-testid="c"]')).not.toBeNull();
    expect(container.textContent).toContain('오래 기다린 순');
  });
});
