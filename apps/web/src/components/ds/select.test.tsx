// UI-3(a9d56577) — ds NativeSelect 회귀가드: 기본 select 유지(접근성) · Input과 같은 모양 · 오류 · 비활성 · 폰 16px · Field와 함께.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
import { NativeSelect } from './select';
import { Field } from './field';

const sel = () => container.querySelector('select') as HTMLSelectElement;

describe('ds NativeSelect', () => {
  it('⭐진짜 <select>다 — 키보드 · 스크린리더 · 폰 기본 선택기가 그대로 산다', async () => {
    await render(<NativeSelect aria-label="역할"><option value="a">관리자</option><option value="b">구성원</option></NativeSelect>);
    expect(sel().options.length).toBe(2);
    expect(sel().getAttribute('aria-label')).toBe('역할');
  });

  it('Input과 같은 모양: 높이 36 · sunk · line-control 경계 · 초점 action · 폰 16px / lg 13', async () => {
    await render(<NativeSelect aria-label="역할"><option>x</option></NativeSelect>);
    const cls = sel().className;
    expect(cls).toContain('h-ds-control');
    expect(cls).toContain('bg-ds-surface-sunk');
    expect(cls).toMatch(/(^|\s)border-ds-line-control(\s|$)/);
    expect(cls).toContain('focus-visible:ring-ds-action');
    expect(cls).toMatch(/(^|\s)text-base(\s|$)/);
    expect(cls).toContain('lg:text-ds-body');
  });

  it('⭐폰(coarse 포인터)은 칸 높이 44 — 평소 36(h-9)은 그대로', async () => {
    await render(<NativeSelect aria-label="역할"><option>x</option></NativeSelect>);
    expect(sel().className).toContain('h-ds-control');
    expect(sel().className).toContain('touch:h-ds-touch');
  });

  it('⭐열리는 칸 표시(expand_more)는 장식이고 클릭을 가로채지 않는다', async () => {
    await render(<NativeSelect aria-label="역할"><option>x</option></NativeSelect>);
    const icon = container.querySelector('[data-icon="expand_more"]') as SVGElement;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('class')).toContain('pointer-events-none');
  });

  it('오류(aria-invalid)는 failed 경계, 비활성은 점선 + ink-3', async () => {
    await render(<NativeSelect aria-label="역할" aria-invalid disabled><option>x</option></NativeSelect>);
    expect(sel().className).toContain('aria-invalid:border-ds-failed');
    expect(sel().className).toContain('disabled:border-dashed');
    expect(sel().disabled).toBe(true);
  });

  it('Field와 함께: 이름 연결 · 오류 글 · aria-describedby', async () => {
    await render(<Field label="역할" error="고르세요">{(c) => <NativeSelect {...c}><option>x</option></NativeSelect>}</Field>);
    expect(container.querySelector('label')!.getAttribute('for')).toBe(sel().id);
    expect(sel().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(sel().getAttribute('aria-describedby')!)!.textContent).toContain('고르세요');
  });

  it('⭐className은 바깥 틀에 걸린다 — 폭을 줄이면 화살표가 칸에 붙어 따라오고, 칸은 틀을 가득 채운다', async () => {
    await render(<NativeSelect aria-label="역할" className="w-40"><option>x</option></NativeSelect>);
    const frame = container.querySelector('[data-slot="ds-select"]') as HTMLElement;
    expect(frame.className).toContain('w-40');
    expect(sel().className).not.toContain('w-40');
    expect(sel().className).toMatch(/(^|\s)w-full(\s|$)/);
    expect(frame.contains(container.querySelector('[data-icon="expand_more"]'))).toBe(true);
  });

  it('값을 바꾸면 onChange가 불린다', async () => {
    let seen = '';
    await render(<NativeSelect aria-label="역할" defaultValue="a" onChange={(e) => { seen = e.target.value; }}><option value="a">A</option><option value="b">B</option></NativeSelect>);
    await act(async () => {
      sel().value = 'b';
      sel().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seen).toBe('b');
  });
});
