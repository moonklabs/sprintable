// @vitest-environment jsdom
//
// story #2051 — 채팅 오디오·비디오 인라인 재생. AC2(목록 진입 시 자동 로딩 금지)가 이 컴포넌트의
// 핵심 제약이라, AttachmentImage(#2050)의 "뷰포트 근접 시 자동 fetch"보다 한 단계 더 보수적으로
// "[재생] 클릭 전엔 네트워크 호출 0"을 실제 DOM(createRoot)으로 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AttachmentMedia } from './attachment-media';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIGNED_URL = 'https://storage.googleapis.com/sprintable-memo-attachments/att-1.mp3?sig=abc';

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubFetch(impl: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AttachmentMedia — story #2051', () => {
  it('[재생]을 누르기 전엔 서명 fetch가 발생하지 않는다(AC2)', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: SIGNED_URL } }) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp3" conversationId="conv-1" label="음성.mp3" kind="audio" />));
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('오디오: [재생] 클릭 시 fetch 후 <audio controls autoPlay>가 렌더된다(AC1)', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: SIGNED_URL } }) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp3" conversationId="conv-1" label="음성.mp3" kind="audio" />));
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe(SIGNED_URL);
    expect(audio?.hasAttribute('controls')).toBe(true);
    expect(audio?.hasAttribute('autoplay')).toBe(true);
  });

  it('비디오: [재생] 클릭 시 fetch 후 <video controls autoPlay>가 렌더된다(AC1)', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: SIGNED_URL } }) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp4" conversationId="conv-1" label="영상.mp4" kind="video" />));
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe(SIGNED_URL);
    expect(video?.hasAttribute('controls')).toBe(true);
  });

  it('idle과 ready 상태의 프레임 크기가 동일하다 — 자리 예약(AC3)', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: SIGNED_URL } }) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp3" conversationId="conv-1" label="음성.mp3" kind="audio" />));
    });
    const idleFrame = container.firstElementChild;
    expect(idleFrame?.className).toContain('h-12');
    expect(idleFrame?.className).toContain('w-72');

    const btn = container.querySelector('button');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const readyFrame = container.firstElementChild;
    expect(readyFrame?.className).toContain('h-12');
    expect(readyFrame?.className).toContain('w-72');
  });

  it('서명 발급이 403이면 접근 거부 안내를 보여준다', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp3" conversationId="conv-1" label="음성.mp3" kind="audio" />));
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('접근 권한이 없습니다');
  });

  it('재생 자체가 실패(onError, 코덱 미지원)하면 형식 안내 + 다운로드 링크로 폴백한다(AC4)', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: SIGNED_URL } }) }));
    await act(async () => {
      root.render(wrap(<AttachmentMedia storedUrl="att-1.mp4" conversationId="conv-1" label="영상.mp4" kind="video" />));
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const video = container.querySelector('video');
    await act(async () => {
      video?.dispatchEvent(new Event('error'));
    });
    expect(container.textContent).toContain('지원하지 않는 형식');
    const downloadLink = container.querySelector('a[download]');
    expect(downloadLink).not.toBeNull();
    expect(downloadLink?.getAttribute('href')).toBe(SIGNED_URL);
  });
});
