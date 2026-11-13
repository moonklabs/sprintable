// @vitest-environment jsdom
// UI-3(a9d56577) — ds Button 회귀가드: 변형 · 크기 · 비활성 · 불러오는 중(눌러도 안 간다) · asChild.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button } from './button';

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
const btn = () => container.querySelector('[data-slot="ds-button"]') as HTMLElement;

describe('ds Button', () => {
  it('변형 넷이 서로 다른 모양: 주 = action 면 · 보조 = line-control 윤곽 · 조용 = 투명 · 위험 = failed 윤곽', async () => {
    const cls: Record<string, string> = {};
    for (const v of ['primary', 'secondary', 'quiet', 'danger'] as const) {
      await act(async () => { root.render(<Button variant={v}>확인</Button>); });
      cls[v] = btn().className;
    }
    expect(cls.primary).toContain('bg-ds-action');
    expect(cls.primary).toContain('text-ds-on-action');
    expect(cls.secondary).toContain('border-ds-line-control');
    expect(cls.quiet).toContain('border-transparent');
    expect(cls.danger).toContain('border-ds-failed');
    expect(cls.danger).toContain('text-ds-failed');
    expect(new Set(Object.values(cls)).size).toBe(4);
  });

  it('기본은 보조 · 크기 28(md) / 36(lg)', async () => {
    await act(async () => { root.render(<Button>기본</Button>); });
    expect(btn().className).toContain('border-ds-line-control');
    expect(btn().className).toContain('h-ds-control-sm');
    await act(async () => { root.render(<Button size="lg">큰</Button>); });
    expect(btn().className).toContain('h-ds-control');
  });

  it('초점 링은 action 2px · 폰은 누름 영역 44 이상', async () => {
    await act(async () => { root.render(<Button>확인</Button>); });
    expect(btn().className).toContain('focus-visible:ring-2');
    expect(btn().className).toContain('focus-visible:ring-ds-action');
    expect(btn().className).toContain('touch:min-h-ds-touch');
  });

  it('비활성은 disabled + 실선 흐린 면 · 흐린 선 + 글 ink-3(색만으로 비활성을 말하지 않는다)', async () => {
    const onClick = vi.fn();
    await act(async () => { root.render(<Button disabled onClick={onClick}>확인</Button>); });
    expect(btn().hasAttribute('disabled') || btn().getAttribute('data-disabled') !== null).toBe(true);
    // aria-disabled: 변형도 부분 문자열로 걸리므로 낱말 경계로 «native :disabled» 쪽을 따로 본다.
    expect(btn().className).toMatch(/(^|\s)disabled:border-ds-line(\s|$)/);
    expect(btn().className).toMatch(/(^|\s)disabled:bg-ds-surface-high(\s|$)/);
    expect(btn().className).not.toContain('border-dashed');
    expect(btn().className).toMatch(/(^|\s)disabled:text-ds-ink-3/);
  });

  it('⭐불러오는 중: aria-busy · 도는 아이콘 · 글 유지 · 눌러도 onClick이 안 불린다', async () => {
    const onClick = vi.fn();
    await act(async () => { root.render(<Button loading onClick={onClick}>저장</Button>); });
    expect(btn().getAttribute('aria-busy')).toBe('true');
    expect(btn().textContent).toContain('저장');
    expect(btn().querySelector('[data-icon="progress_activity"]')).not.toBeNull();
    await act(async () => { btn().click(); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('평소에는 눌리면 onClick이 불린다', async () => {
    const onClick = vi.fn();
    await act(async () => { root.render(<Button onClick={onClick}>저장</Button>); });
    await act(async () => { btn().click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(btn().getAttribute('aria-busy')).toBeNull();
  });

  it('asChild면 자식 요소(링크)에 같은 모양을 입힌다', async () => {
    await act(async () => { root.render(<Button asChild variant="primary"><a href="https://example.com/x">이동</a></Button>); });
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.className).toContain('bg-ds-action');
  });

  it('글 앞 아이콘 자리', async () => {
    await act(async () => { root.render(<Button iconStart={<span data-testid="ic" />}>추가</Button>); });
    expect(container.querySelector('[data-testid="ic"]')).not.toBeNull();
  });

  it('⭐asChild + disabled: 링크가 aria-disabled · 초점 밖이 되고 눌러도 자식 onClick · 이동이 막힌다', async () => {
    const childClick = vi.fn();
    const own = vi.fn();
    await act(async () => { root.render(<Button asChild disabled onClick={own}><a href="https://example.com/delete" onClick={childClick}>삭제</a></Button>); });
    const a = container.querySelector('a')!;
    expect(a.getAttribute('aria-disabled')).toBe('true');
    expect(a.getAttribute('tabindex')).toBe('-1');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { a.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(childClick).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
  });

  it('⭐asChild + loading: 도는 아이콘 · aria-busy · 자식 onClick이 안 불리고 이동도 막힌다', async () => {
    const childClick = vi.fn();
    await act(async () => { root.render(<Button asChild loading><a href="https://example.com/save" onClick={childClick}>저장</a></Button>); });
    const a = container.querySelector('a')!;
    expect(a.getAttribute('aria-busy')).toBe('true');
    expect(a.getAttribute('aria-disabled')).toBe('true');
    expect(a.querySelector('[data-icon="progress_activity"]')).not.toBeNull();
    expect(a.textContent).toContain('저장');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { a.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(childClick).not.toHaveBeenCalled();
  });

  it('asChild 평소: 자식 onClick과 단추 onClick이 둘 다 불리고 aria-disabled가 없다', async () => {
    const childClick = vi.fn();
    const own = vi.fn();
    await act(async () => { root.render(<Button asChild onClick={own}><a href="https://example.com/x" onClick={childClick}>이동</a></Button>); });
    const a = container.querySelector('a')!;
    expect(a.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { a.click(); });
    expect(childClick).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('키보드: 불러오는 중 단추는 Enter · Space 클릭(프로그램 클릭 포함)도 onClick을 못 부른다', async () => {
    const onClick = vi.fn();
    await act(async () => { root.render(<Button loading onClick={onClick}>저장</Button>); });
    const el = btn();
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); el.click(); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('⭐asChild + disabled/loading 링크도 비활성 «모양»을 입는다(aria-disabled: 실선 흐린 면 · 글 ink-3 · 눌림 없음)', async () => {
    await act(async () => { root.render(<Button asChild disabled variant="primary"><a href="https://example.com/x">삭제</a></Button>); });
    const cls = container.querySelector('a')!.className;
    expect(cls).toContain('aria-disabled:border-ds-line');
    expect(cls).toContain('aria-disabled:text-ds-ink-3');
    expect(cls).toContain('aria-disabled:bg-ds-surface-high');
    expect(cls).not.toContain('border-dashed');
    expect(cls).toContain('aria-disabled:pointer-events-none');
  });

  it('⭐asChild에 Fragment를 주면 그리지 않는다(가드를 새게 하지 않는다)', async () => {
    const childClick = vi.fn();
    const frag = (<><a href="https://example.com/x" onClick={childClick}>이동</a></>) as never;
    await act(async () => { root.render(<Button asChild loading>{frag}</Button>); });
    expect(container.querySelector('a')).toBeNull();
  });
});
