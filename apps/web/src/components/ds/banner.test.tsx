// UI-3(a9d56577) — ds Banner 회귀가드: 네 변형의 뜻 · 역할 · 아이콘 · 행동 · 닫기.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

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
import { Banner } from './banner';

const el = () => container.querySelector('[data-slot="ds-banner"]') as HTMLElement;

describe('ds Banner', () => {
  it('네 변형이 서로 다른 모양: 안내 info · 사람이 할 일 needs-hand(막대 + touch_app) · 실패 failed · 그 밖 중립', async () => {
    const want: Record<string, [string, string]> = {
      info: ['bg-ds-info-soft', 'info'], 'needs-hand': ['bg-ds-needs-hand-soft', 'touch_app'], failed: ['bg-ds-failed-soft', 'error'], note: ['bg-ds-surface-high', 'warning'],
    };
    const seen = new Set<string>();
    for (const [tone, [cls, icon]] of Object.entries(want)) {
      await render(<Banner tone={tone as never}>글</Banner>);
      expect(el().className, tone).toContain(cls);
      expect(el().querySelector(`[data-icon="${icon}"]`), tone).not.toBeNull();
      seen.add(el().className);
    }
    expect(seen.size).toBe(4);
    await render(<Banner tone="needs-hand">글</Banner>);
    expect(el().className).toMatch(/border-l-ds-needs-hand(\s|$)/);
    expect(el().className).not.toContain('border-l-ds-needs-hand-bar');
  });

  it('⭐실패만 role=alert, 나머지는 role=status(흐름을 끊지 않음)', async () => {
    for (const tone of ['info', 'needs-hand', 'note'] as const) {
      await render(<Banner tone={tone}>글</Banner>);
      expect(el().getAttribute('role'), tone).toBe('status');
    }
    await render(<Banner tone="failed">글</Banner>);
    expect(el().getAttribute('role')).toBe('alert');
  });

  it("⭐announce='assertive'는 어느 변형이든 role=alert로 올린다(옛 Alert 경고가 즉시 읽히던 것 — 모양은 그대로) · 주지 않으면 지금과 같다", async () => {
    await render(<Banner tone="note" announce="assertive">글</Banner>);
    expect(el().getAttribute('role')).toBe('alert');
    expect(el().getAttribute('data-tone')).toBe('note'); // still painted as a note, not a failure
    await render(<Banner tone="note">글</Banner>);
    expect(el().getAttribute('role')).toBe('status');
  });

  it('그 밖의 경고(note)는 호박 색을 만들지 않는다 — 손 필요 색이 하나도 없다', async () => {
    await render(<Banner tone="note">글</Banner>);
    expect(el().className).not.toContain('needs-hand');
  });

  it('행동 슬롯과 닫기: 닫기는 onDismiss가 있을 때만, 이름은 «닫기»', async () => {
    const onDismiss = vi.fn();
    await render(<Banner action={<button type="button">다시 연결</button>}>끊겼어요</Banner>);
    expect(el().textContent).toContain('다시 연결');
    expect(el().querySelector('button[aria-label="닫기"]')).toBeNull();
    await render(<Banner onDismiss={onDismiss}>글</Banner>);
    await act(async () => { (el().querySelector('button[aria-label="닫기"]') as HTMLElement).click(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
