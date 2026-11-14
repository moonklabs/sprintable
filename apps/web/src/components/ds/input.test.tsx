// UI-3(a9d56577) — ds Input · Textarea 회귀가드: 토큰 · 초점 · 오류 · 비활성 · iOS 확대 방지 글자.
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
import { Input, Textarea } from './input';

const input = () => container.querySelector('[data-slot="ds-input"]') as HTMLInputElement;
const area = () => container.querySelector('[data-slot="ds-textarea"]') as HTMLTextAreaElement;

describe('ds Input', () => {
  it('높이 36 · sunk 바탕 · line-control 경계 · 초점 action', async () => {
    await render(<Input aria-label="이름" />);
    const cls = input().className;
    expect(cls).toContain('h-ds-control');
    expect(cls).toContain('bg-ds-surface-sunk');
    expect(cls).toMatch(/(^|\s)border-ds-line-control(\s|$)/);
    // 4906 · 글 칸의 초점 = 중립 테두리 한 단계 짙어짐 — 파란 틀(action 테두리 · 고리) 0
    expect(cls).toContain('focus-visible:border-ds-ink-2');
    expect(cls).not.toMatch(/focus(-visible|-within)?:(ring|border)-ds-action/);
  });

  it('⭐폰(coarse 포인터)은 높이 44 — 평소 36(h-9)은 그대로이고 호출부 className이 평소 높이를 줄여도 폰 44는 남는다', async () => {
    await render(<Input aria-label="이름" />);
    expect(input().className).toContain('touch:h-ds-touch');
    await render(<Input aria-label="이름" className="h-8" />);
    expect(input().className).toContain('touch:h-ds-touch');
    expect(input().className).not.toMatch(/(^|\s)h-ds-control(\s|$)/);
  });

  it('⭐폰은 16px(text-base)이고 lg부터 본문 13 — iOS가 16px 미만 칸에서 화면을 확대하지 않게', async () => {
    await render(<Input aria-label="이름" />);
    expect(input().className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(input().className).toContain('lg:text-ds-body');
  });

  it('⭐오류(aria-invalid)는 failed 경계 · 비활성은 «메워진 우물»(바탕과 같은 면) + 흐린 선 + ink-3(색만이 아닌 면 · 선 · 글)', async () => {
    await render(<Input aria-label="이름" aria-invalid />);
    expect(input().className).toContain('aria-invalid:border-ds-failed');
    await render(<Input aria-label="이름" disabled />);
    expect(input().disabled).toBe(true);
    expect(input().className).toContain('disabled:bg-ds-background');
    expect(input().className).not.toContain('disabled:bg-ds-surface-high'); // 켜진 우물(sunk)보다 밝은 «올라온 면»이 아님 (4924 후속)
    expect(input().className).toContain('disabled:border-ds-line');
    expect(input().className).not.toContain('border-dashed');
    expect(input().className).toContain('disabled:text-ds-ink-3');
  });

  it('값을 받고 바뀌면 onChange가 불린다', async () => {
    let seen = '';
    await render(<Input aria-label="이름" defaultValue="가" onChange={(e) => { seen = e.target.value; }} />);
    expect(input().value).toBe('가');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '가나');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toBe('가나');
  });
});

describe('ds Textarea', () => {
  it('Input과 같은 토큰 · 최소 높이 64 · 세로로만 늘어남', async () => {
    await render(<Textarea aria-label="사유" />);
    const cls = area().className;
    expect(cls).toContain('min-h-16');
    expect(cls).toContain('resize-y');
    expect(cls).toContain('bg-ds-surface-sunk');
    expect(cls).toContain('aria-invalid:border-ds-failed');
    expect(cls).toMatch(/(^|\s)text-base(\s|$)/);
  });
});

describe('ds Input — className은 문자열만', () => {
  it('호출부 className이 칸에 실린다(함수 className은 타입이 막는다)', async () => {
    await render(<Input aria-label="이름" className="max-w-40" />);
    expect(input().className).toContain('max-w-40');
  });
});
