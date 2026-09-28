// @vitest-environment jsdom
//
// [SID:4388] 하나 고르기 단추가 고른 값을 모양으로만 보이던 자리(`A === B ?` 같음 비교) — 고른 쪽 판단은 화면의 기존 조건 그대로 두고
// `aria-pressed`만 실었다. 대표 화면 셋(설정 새로고침 주기 · 가설 방향 · 산출물 내보내기 테마)에서 고른 단추만 눌림이고, 누르면 옮겨 간다.
// 옛 코드에선 이 단추들에 상태 속성이 아예 없어 RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 이 실행 환경의 jsdom에 localStorage가 없을 수 있어(새로고침 주기가 저장값을 읽음) 메모리 판으로 둔다.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function mount(node: React.ReactNode) {
  act(() => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
}

/** 한 묶음(같은 부모 아래 aria-pressed 단추들)에서 눌린 단추의 글. */
function pressedIn(group: Element): string[] {
  return [...group.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent ?? '');
}

async function click(el: Element) {
  await act(async () => { (el as HTMLButtonElement).click(); });
}

describe('[SID:4388] 하나 고르기 단추 — 고른 값이 상태 속성으로도 닿는다', () => {
  it('⭐설정 · 새로고침 주기: 고른 주기만 aria-pressed=true · 다른 주기를 누르면 옮겨 간다', async () => {
    const { RefreshProvider } = await import('@/contexts/refresh-context');
    const { RefreshSettings } = await import('@/components/settings/refresh-settings');
    mount(<RefreshProvider><RefreshSettings /></RefreshProvider>);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every((b) => b.hasAttribute('aria-pressed'))).toBe(true);
    expect(pressedIn(container)).toHaveLength(1);
    const other = buttons.find((b) => b.getAttribute('aria-pressed') === 'false')!;
    await click(other);
    expect(pressedIn(container)).toEqual([other.textContent]);
  });

  it('⭐가설 방향: 고른 방향만 눌림 · 다른 방향을 누르면 옮겨 간다', async () => {
    const { HypothesisForm } = await import('@/components/hypotheses/hypothesis-form');
    mount(<HypothesisForm onSubmit={() => {}} onCancel={() => {}} />);
    const directionButtons = [...container.querySelectorAll('button[aria-pressed]')];
    expect(directionButtons.length).toBeGreaterThan(1);
    const group = directionButtons[0].parentElement!;
    const before = pressedIn(group);
    expect(before.length).toBeLessThanOrEqual(1);
    const target = [...group.querySelectorAll('button[aria-pressed="false"]')][0]!;
    await click(target);
    expect(pressedIn(group)).toEqual([target.textContent]);
  });

  it('⭐산출물 내보내기 테마: 지금 테마(light)만 눌림 · dark를 누르면 옮겨 간다', async () => {
    const { ExportDialog } = await import('@/components/canvas/export-dialog');
    mount(<ExportDialog open onOpenChange={() => {}} artifactId="a1" versionNumber={1} captureTargetRef={{ current: null }} artifactFormat="image" />);
    const K = koMessages.canvas as Record<string, string>;
    const themeButtons = [...document.querySelectorAll('button[aria-pressed]')].filter((b) => b.textContent === K.themeLight || b.textContent === K.themeDark);
    expect(themeButtons).toHaveLength(2);
    const group = themeButtons[0].parentElement!;
    expect(pressedIn(group)).toEqual([K.themeLight]);
    await click(themeButtons.find((b) => b.textContent === K.themeDark)!);
    expect(pressedIn(group)).toEqual([K.themeDark]);
  });
});
