// @vitest-environment jsdom
//
// [SID:4375] AC1 — 목표 만들기 창 «✕»(아이콘만)에 접근 이름이 없어 화면 읽기가 «버튼»으로만 읽었다(유나 PR 4753 판 곁 발견).
// 공용 «닫기» 키(common.close)를 aria-label로 — ko · en 둘 다 보고, 창 안 모든 버튼이 이름(aria-label 또는 글)을 갖는지도 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('./goals-context', () => ({
  useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ currentMemberType: 'human' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, json: async () => ({}) };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((n) => n.remove());
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function openCreateDialog(locale: 'ko' | 'en') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  const { GoalsClient } = await import('./goals-client');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <GoalsClient projectId="proj-1" />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const createBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(messages.goals.newGoal));
  expect(createBtn, 'newGoal 버튼').toBeTruthy();
  await act(async () => { createBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
  expect(dialog, '목표 만들기 창').toBeTruthy();
  expect(dialog!.textContent).toContain(messages.goals.createGoal);
  return dialog!;
}

/** 제목 줄의 «✕» = 글 없이 svg만 든 버튼. */
function headerCloseButton(dialog: HTMLElement): HTMLButtonElement {
  const iconOnly = [...dialog.querySelectorAll('button')].filter((b) => !b.textContent?.trim() && b.querySelector('svg'));
  expect(iconOnly).toHaveLength(1);
  return iconOnly[0]!;
}

describe('[SID:4375] 목표 만들기 창 «✕» 접근 이름', () => {
  it('ko: «✕» 이름 = common.close «닫기» · 누르면 창이 닫힌다', async () => {
    const dialog = await openCreateDialog('ko');
    const close = headerCloseButton(dialog);
    expect(close.getAttribute('aria-label')).toBe(koMessages.common.close);
    expect(koMessages.common.close).toBe('닫기');
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('en: «✕» 이름 = common.close «Close»', async () => {
    const dialog = await openCreateDialog('en');
    expect(headerCloseButton(dialog).getAttribute('aria-label')).toBe(enMessages.common.close);
  });

  it('창 안 모든 버튼이 이름(aria-label 또는 보이는 글)을 갖는다', async () => {
    const dialog = await openCreateDialog('ko');
    const nameless = [...dialog.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label')?.trim() && !b.textContent?.trim());
    expect(nameless.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
  });
});
