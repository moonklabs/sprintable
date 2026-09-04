// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ScheduleAtDialog } from './schedule-at-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

// React가 <input>의 value를 네이티브 값 트래커로 관리해서 `input.value = x` 뒤 bare
// 'change' 이벤트만 쏘면 onChange가 안 불린다(흔한 jsdom 함정) — 네이티브 setter로
// 직접 지정하고 'input' 이벤트를 쏴야 React 컨트롤드 인풋이 감지한다.
function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('ScheduleAtDialog — story #3422 ②-d 2/N', () => {
  it('⭐과거 시각을 확認 누르면 onSubmit이 안 불리고 에러가 뜬다(validateScheduledAt 재사용)', async () => {
    let called: string | null = null;
    await act(async () => {
      root.render(wrap(<ScheduleAtDialog open onOpenChange={() => {}} onSubmit={(iso) => { called = iso; }} />));
    });
    await flush();
    const input = document.body.querySelector('[data-testid="channel-post-schedule-at-input"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(input, '2020-01-01T00:00');
    });
    const confirm = document.body.querySelector('[data-testid="channel-post-schedule-at-confirm"]') as HTMLButtonElement;
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).toBeNull();
    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-error"]')?.textContent)
      .toBe(koMessages.content.channelPostsScheduleAtErrorPast);
  });

  it('⭐미래 시각을 확認 누르면 onSubmit(iso)가 불린다', async () => {
    let called: string | null = null;
    await act(async () => {
      root.render(wrap(<ScheduleAtDialog open onOpenChange={() => {}} onSubmit={(iso) => { called = iso; }} />));
    });
    await flush();
    const futureLocal = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);
    const input = document.body.querySelector('[data-testid="channel-post-schedule-at-input"]') as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(input, futureLocal);
    });
    const confirm = document.body.querySelector('[data-testid="channel-post-schedule-at-confirm"]') as HTMLButtonElement;
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(called).not.toBeNull();
    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-error"]')).toBeNull();
  });

  it('입력 전(빈 값)에는 에러를 안 보인다(손대기 전엔 아무 말도 안 한다)', async () => {
    await act(async () => {
      root.render(wrap(<ScheduleAtDialog open onOpenChange={() => {}} onSubmit={() => {}} />));
    });
    await flush();
    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-error"]')).toBeNull();
  });
});
