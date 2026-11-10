// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Card, CardInset } from './card';

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
const card = () => container.querySelector('[data-slot="ds-card"]') as HTMLElement;

describe('ds Card', () => {
  it('기본: 올린 면 + 헤어라인 + 모서리 4 · 그림자 없음', async () => {
    await act(async () => { root.render(<Card>내용</Card>); });
    expect(card().className).toContain('bg-ds-surface');
    expect(card().className).toContain('border-ds-line');
    expect(card().className).toContain('rounded-ds-control');
    expect(card().className).not.toContain('shadow');
  });

  it('⭐손 필요 카드는 왼쪽 4px 막대', async () => {
    await act(async () => { root.render(<Card tone="needs-hand" toneLabel="내 손이 필요">내용</Card>); });
    expect(card().className).toContain('border-l-4');
    expect(card().className).toContain('border-l-ds-needs-hand-bar');
  });

  it('선택: action 윤곽 + aria-current', async () => {
    await act(async () => { root.render(<Card selected>내용</Card>); });
    expect(card().className).toContain('ring-ds-action');
    expect(card().getAttribute('aria-current')).toBe('true');
  });

  it('CardInset은 한 단계 내린 면 + 고정폭', async () => {
    await act(async () => { root.render(<CardInset>파일 4</CardInset>); });
    const i = container.querySelector('[data-slot="ds-card-inset"]')!;
    expect(i.className).toContain('bg-ds-surface-sunk');
    expect(i.className).toContain('font-mono');
  });

  it('⭐손 필요 카드는 막대 색 말고 읽히는 이름도 가진다 · 기본 카드는 없다', async () => {
    await act(async () => { root.render(<Card tone="needs-hand" toneLabel="내 손이 필요">내용</Card>); });
    expect(card().querySelector('.sr-only')?.textContent).toBe('내 손이 필요');
    expect(card().getAttribute('toneLabel')).toBeNull();
    await act(async () => { root.render(<Card>내용</Card>); });
    expect(card().querySelector('.sr-only')).toBeNull();
  });

  it('⭐선택 + 손 필요를 같이 줘도 왼쪽 막대와 선택 윤곽이 둘 다 남는다', async () => {
    await act(async () => { root.render(<Card tone="needs-hand" toneLabel="내 손이 필요" selected>내용</Card>); });
    expect(card().className).toContain('border-l-ds-needs-hand-bar');
    expect(card().className).toContain('border-l-4');
    expect(card().className).toContain('ring-ds-action');
    expect(card().getAttribute('aria-current')).toBe('true');
  });
});
