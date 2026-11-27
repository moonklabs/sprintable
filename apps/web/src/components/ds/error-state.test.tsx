// story 5048 ⑤ — ds ErrorState 회귀가드: EmptyState와 같은 뼈대 · 잉크 제목 + 붉은 아이콘 · role=alert · 재시도는 ds Button(40 · 폰 44).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';

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
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }
const err = () => container.querySelector('[data-slot="ds-error-state"]') as HTMLElement;
const empty = () => container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
const cls = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean).sort().join(' ');

describe('ds ErrorState', () => {
  it('⭐EmptyState와 같은 뼈대 — 기본 · inline 모두 루트 클래스가 똑같다(둘 중 하나만 바뀌면 빨강)', async () => {
    for (const size of ['default', 'inline'] as const) {
      await render(<EmptyState size={size} title="비었어요" />);
      const e = cls(empty());
      await render(<ErrorState size={size} title="못 했어요" />);
      expect(cls(err()), size).toBe(e);
    }
    // 뼈대가 같은 «한 곳»(state-block)에서 흔들리면 두 부품이 같이 바뀌어 위 비교는 못 잡는다 — 값 그대로도 못 박는다(빈 상태 모양이 안 바뀐다는 약속 · codex 지적).
    await render(<ErrorState title="못 했어요" className="mt-2" />);
    expect(err().className).toBe('flex flex-col items-center gap-2 px-6 text-center py-10 mt-2');
    await render(<ErrorState size="inline" title="못 했어요" />);
    expect(err().className).toBe('flex flex-col items-center gap-2 px-6 text-center py-4');
    await render(<EmptyState title="비었어요" className="mt-2" />);
    expect(empty().className).toBe('flex flex-col items-center gap-2 px-6 text-center py-10 mt-2');
    await render(<EmptyState size="inline" title="비었어요" />);
    expect(empty().className).toBe('flex flex-col items-center gap-2 px-6 text-center py-4');
  });

  it('⭐role=alert · 제목은 잉크(붉은 글자 클래스 0) · 붉은 건 아이콘뿐 · 아이콘은 기본 lg 24(inline은 sm 16)', async () => {
    await render(<ErrorState title="일감을 불러오지 못했어요" description="잠시 뒤에 다시 해 주세요" />);
    expect(err().getAttribute('role')).toBe('alert');
    const [title, desc] = Array.from(err().querySelectorAll('p'));
    expect(title!.textContent).toBe('일감을 불러오지 못했어요');
    expect(title!.className).toContain('text-ds-ink');
    expect(desc!.className).toContain('text-ds-ink-2');
    for (const p of [title!, desc!]) expect(p.className).not.toMatch(/text-ds-failed|text-red|text-destructive/);
    const icon = err().querySelector('[data-icon="error"]') as SVGElement | HTMLElement;
    expect(icon.getAttribute('class')).toContain('text-ds-failed');
    expect(icon.getAttribute('width')).toBe('24');
    await render(<ErrorState size="inline" title="x" />);
    expect((err().querySelector('[data-icon="error"]') as Element).getAttribute('width')).toBe('16');
  });

  it('제목을 안 주면 «문제가 발생했어요»(common.error) · 설명 · 행동은 없으면 안 그린다', async () => {
    await render(<ErrorState />);
    expect(err().querySelectorAll('p')).toHaveLength(1);
    expect(err().querySelector('p')!.textContent).toBe(koMessages.common.error);
    expect(err().querySelector('button')).toBeNull();
  });

  it('⭐다시 시도 = ds Button(보조 · 높이 40 · 폰 44) — onRetry가 있을 때만 · 눌리면 한 번 부른다 · 말은 바꿀 수 있다', async () => {
    const onRetry = vi.fn();
    await render(<ErrorState title="x" onRetry={onRetry} />);
    const btn = err().querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe(koMessages.common.retry);
    expect(btn.className).toContain('h-ds-control-sm');
    expect(btn.className).toContain('touch:min-h-ds-touch');
    expect(btn.className).toContain('bg-ds-surface-sunk');
    await act(async () => { btn.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    await render(<ErrorState title="x" onRetry={onRetry} retryLabel="다시 불러오기" />);
    expect(err().querySelector('button')!.textContent).toBe('다시 불러오기');
  });

  it('다른 행동(children)은 재시도 옆에 붙는다 · 재시도 없이 children만도 된다', async () => {
    await render(<ErrorState title="x" onRetry={() => {}}><button type="button">문의하기</button></ErrorState>);
    expect(Array.from(err().querySelectorAll('button')).map((b) => b.textContent)).toEqual([koMessages.common.retry, '문의하기']);
    await render(<ErrorState title="x"><button type="button">문의하기</button></ErrorState>);
    expect(err().querySelectorAll('button')).toHaveLength(1);
  });
});
