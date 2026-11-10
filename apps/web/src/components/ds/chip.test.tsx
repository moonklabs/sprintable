// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AgentTag, Chip, Tag } from './chip';
import koMessages from '../../../messages/ko.json';

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
const chip = () => container.querySelector('[data-slot="ds-chip"]') as HTMLElement;

describe('ds Chip', () => {
  it('뜻마다 다른 색: 손 필요 · 끝남 · 실패 · AI 표시 · 선택', async () => {
    const want: Record<string, string> = {
      'needs-hand': 'text-ds-needs-hand', done: 'text-ds-done', failed: 'text-ds-failed', info: 'text-ds-info', action: 'text-ds-action-text', neutral: 'text-ds-ink-2',
    };
    for (const [tone, cls] of Object.entries(want)) {
      await act(async () => { root.render(<Chip tone={tone as never}>상태</Chip>); });
      expect(chip().className, tone).toContain(cls);
    }
  });

  it('⭐경계는 항상 중립 line — 뜻 색은 글과 옅은 바탕에만(색만으로 뜻을 싣지 않는다)', async () => {
    await act(async () => { root.render(<Chip tone="failed">실패</Chip>); });
    expect(chip().className).toContain('border-ds-line');
    expect(chip().className).not.toContain('border-ds-failed');
    expect(chip().className).toContain('bg-ds-failed-soft');
  });

  it('점은 장식(aria-hidden) · 뜻 색의 점', async () => {
    await act(async () => { root.render(<Chip tone="done" dot>끝남</Chip>); });
    const dot = chip().querySelector('[data-chip-dot]')!;
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.className).toContain('bg-ds-done');
    expect(chip().textContent).toBe('끝남');
  });

  it('아이콘 칩(손 필요 touch_app)', async () => {
    await act(async () => { root.render(<Chip tone="needs-hand" icon="touch_app">결재 대기</Chip>); });
    expect(chip().querySelector('[data-icon="touch_app"]')).not.toBeNull();
  });

  it('Tag는 중립 고정폭 · AgentTag는 현행 chats.agent 낱말(ko 에이전트)', async () => {
    await act(async () => { root.render(<Tag>AI</Tag>); });
    expect(container.querySelector('[data-slot="ds-tag"]')!.className).toContain('bg-ds-surface-high');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentTag />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[data-slot="ds-agent-tag"]')!.textContent).toBe('에이전트');
  });

  it('⭐앞 표시는 점 또는 아이콘 하나 — dot이 있으면 아이콘은 그리지 않는다', async () => {
    await act(async () => { root.render(<Chip tone="needs-hand" icon="touch_app">손 필요</Chip>); });
    expect(chip().querySelector('[data-icon="touch_app"]')).not.toBeNull();
    expect(chip().querySelector('[data-chip-dot]')).toBeNull();
    await act(async () => { root.render(<Chip tone="done" dot>끝남</Chip>); });
    expect(chip().querySelector('[data-icon]')).toBeNull();
    // 타입이 막는 조합 — 런타임에서도 점만 그린다.
    const both = { dot: true, icon: 'touch_app' } as Record<string, unknown>;
    await act(async () => { root.render(<Chip tone="done" {...both}>둘 다</Chip>); });
    expect(chip().querySelector('[data-icon]')).toBeNull();
  });
});
