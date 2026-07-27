// @vitest-environment jsdom
//
// story #2050 — 채팅 첨부 이미지가 자리 예약 없이 로드돼(skeleton h-32 vs 로딩 후 max-h-40
// 가변) 스크롤 위치를 밀던 회귀 재현. 이 테스트는 idle → 뷰포트 진입(IntersectionObserver
// 콜백) → 서명 fetch 완료(ok) 왕복에서 컨테이너의 고정 프레임(h-32 w-60)이 두 상태 모두
// 동일한지를 실제 DOM(createRoot)으로 검증한다 — 정적 클래스 존재 주장이 아니라 상태 전이를
// 실제로 트리거해 확認한다. 아울러 뷰포트 근접 전에는 서명 fetch가 발생하지 않는 것(대화
// 진입 시 동시다발 fetch 방지)과, 클릭 시 원본(서명 URL 그대로)이 열리는 것도 함께 잠근다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AttachmentImage } from './attachment-image';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-next-image="true" />,
}));

const SIGNED_URL = 'https://storage.googleapis.com/sprintable-memo-attachments/att-1.png?sig=abc';

let container: HTMLDivElement;
let root: Root;
let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null;
let ioDisconnect: ReturnType<typeof vi.fn>;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  ioCallback = null;
  ioDisconnect = vi.fn();
  class FakeIntersectionObserver {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      ioCallback = cb;
    }
    observe = vi.fn();
    disconnect = ioDisconnect;
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { url: SIGNED_URL } }),
    })),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AttachmentImage — story #2050', () => {
  it('뷰포트 진입 전에는 서명 fetch가 발생하지 않는다', async () => {
    await act(async () => {
      root.render(wrap(<AttachmentImage storedUrl="att-1.png" conversationId="conv-1" alt="사진" />));
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('idle(스켈레톤)과 ok(이미지) 상태의 프레임 크기가 동일하다 — 레이아웃 시프트 0', async () => {
    await act(async () => {
      root.render(wrap(<AttachmentImage storedUrl="att-1.png" conversationId="conv-1" alt="사진" />));
    });

    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.className).toContain('h-32');
    expect(skeleton?.className).toContain('w-60');

    // 뷰포트 진입 트리거 → 서명 fetch → ok 상태로 전이.
    await act(async () => {
      ioCallback?.([{ isIntersecting: true }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(ioDisconnect).toHaveBeenCalled();

    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    // 회귀 지점: 기존 코드는 ok 상태에서 `max-h-40 max-w-[240px]`(가변)로 바뀌어 skeleton의
    // h-32와 불일치했다 — 수정 후에는 동일 고정 프레임(h-32 w-60)을 유지해야 한다.
    expect(link?.className).toContain('h-32');
    expect(link?.className).toContain('w-60');
  });

  it('클릭 시 원본(서명 URL)을 그대로 연다', async () => {
    await act(async () => {
      root.render(wrap(<AttachmentImage storedUrl="att-1.png" conversationId="conv-1" alt="사진" />));
    });
    await act(async () => {
      ioCallback?.([{ isIntersecting: true }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(SIGNED_URL);
    expect(link?.getAttribute('target')).toBe('_blank');

    const img = container.querySelector('img[data-next-image="true"]');
    expect(img?.getAttribute('src')).toBe(SIGNED_URL);
  });
});
