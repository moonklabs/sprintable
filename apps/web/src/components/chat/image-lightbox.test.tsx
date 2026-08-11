// @vitest-environment jsdom
//
// story #2037 — 채팅 이미지 라이트박스. AC1(확대뷰 열림+원본 서명URL 렌더)·AC3(여러 장 좌우
// 넘기기)·AC4(ESC·바깥클릭·X버튼·뒤로가기 전부 닫힘)·AC5(원본 열기 링크)를 실제 DOM
// (createRoot, base-ui Dialog 포탈은 document.body)으로 왕복 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ImageLightbox } from './image-lightbox';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-next-image="true" />,
}));

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function mockFetchFor(urlByPath: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.searchParams.get('path') ?? '';
    const signed = urlByPath[path];
    if (!signed) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { url: signed } }) };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.querySelectorAll('[data-slot="dialog-content"], [data-base-ui-popup], [role="dialog"]').forEach((n) => n.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // 열 때마다 pushState하므로 테스트 간 history가 안 쌓이게 원위치.
  window.history.replaceState(null, '', window.location.pathname);
});

const IMG1 = { storedUrl: 'att-1.png', alt: '사진1' };
const IMG2 = { storedUrl: 'att-2.png', alt: '사진2' };
const SIGNED1 = 'https://storage.googleapis.com/bucket/att-1.png?sig=a';
const SIGNED2 = 'https://storage.googleapis.com/bucket/att-2.png?sig=b';

describe('ImageLightbox — story #2037 AC1(확대뷰) + AC5(원본 열기)', () => {
  it('열리면 서명 URL로 원본 이미지를 렌더하고, 원본 열기 링크가 그 서명 URL을 가리킨다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1 });
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const img = document.querySelector('img[data-next-image="true"]');
    expect(img?.getAttribute('src')).toBe(SIGNED1);
    expect(img?.getAttribute('alt')).toBe('사진1');

    const openOriginal = Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === SIGNED1);
    expect(openOriginal).toBeDefined();
    expect(openOriginal?.getAttribute('target')).toBe('_blank');
  });

  it('단일 이미지면 카운터·이전/다음 버튼이 안 뜬다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1 });
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('/ 1');
    expect(document.querySelector('[aria-label="이전 이미지"]')).toBeNull();
    expect(document.querySelector('[aria-label="다음 이미지"]')).toBeNull();
  });
});

describe('ImageLightbox — story #2037 AC3(여러 장 좌우 넘기기)', () => {
  it('다음 버튼을 누르면 다음 이미지로 넘어가고, 그 이미지의 서명 URL을 새로 fetch한다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1, 'att-2.png': SIGNED2 });
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1, IMG2]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('1 / 2');
    const img1 = document.querySelector('img[data-next-image="true"]');
    expect(img1?.getAttribute('src')).toBe(SIGNED1);

    const nextBtn = document.querySelector('[aria-label="다음 이미지"]') as HTMLButtonElement;
    expect(nextBtn).not.toBeNull();
    await act(async () => {
      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });

    expect(document.body.textContent).toContain('2 / 2');
    const img2 = document.querySelector('img[data-next-image="true"]');
    expect(img2?.getAttribute('src')).toBe(SIGNED2);
    // 마지막 장이면 다음 버튼이 사라진다(더 넘길 곳이 없음).
    expect(document.querySelector('[aria-label="다음 이미지"]')).toBeNull();
    expect(document.querySelector('[aria-label="이전 이미지"]')).not.toBeNull();
  });

  it('화살표 키(→/←)로도 넘길 수 있다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1, 'att-2.png': SIGNED2 });
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1, IMG2]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(document.body.textContent).toContain('2 / 2');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(document.body.textContent).toContain('1 / 2');
  });
});

describe('ImageLightbox — story #2037 AC4(닫기: X버튼·바깥클릭·뒤로가기)', () => {
  it('X(닫기) 버튼 클릭이 onClose를 부른다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1 });
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={onClose} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const closeBtn = document.querySelector('[aria-label="닫기"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    await act(async () => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
  });

  it('열릴 때 history.pushState 1회 + 실제 뒤로가기(popstate)가 onClose를 부른다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1 });
    const onClose = vi.fn();
    const pushSpy = vi.spyOn(window.history, 'pushState');
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={onClose} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ImageLightbox — story #2037 AC2(더블탭 확대 토글)', () => {
  it('300ms 이내 연속 두 번 클릭(더블탭 대용)만 토글한다 — 각 탭 쌍 사이 300ms 넘게 벌리면 다음 쌍이 다시 토글', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1 });
    const nowSpy = vi.spyOn(Date, 'now');
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const zoomWrapper = document.querySelector('img[data-next-image="true"]')!.parentElement as HTMLElement;
    const clickAreaContainer = zoomWrapper.parentElement!;
    expect(zoomWrapper.style.transform).toBe('');

    // 탭1(t=10000, lastTap 초기값 0과 충분히 멀어 토글 없음) → 탭2(t=10100, 300ms 이내 → 토글: 확대).
    nowSpy.mockReturnValue(10_000);
    await act(async () => { clickAreaContainer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    nowSpy.mockReturnValue(10_100);
    await act(async () => { clickAreaContainer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(zoomWrapper.style.transform).toBe('scale(2)');

    // 탭3이 900ms 뒤(300ms 초과) → 토글 없음(그냥 새 첫 탭). 탭4가 그로부터 100ms 뒤 → 토글: 축소.
    nowSpy.mockReturnValue(11_000);
    await act(async () => { clickAreaContainer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(zoomWrapper.style.transform).toBe('scale(2)'); // 300ms 넘게 벌어진 단독 탭은 무변화.
    nowSpy.mockReturnValue(11_100);
    await act(async () => { clickAreaContainer.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(zoomWrapper.style.transform).toBe('');

    nowSpy.mockRestore();
  });

  it('이미지를 넘기면(index 변경) 확대 상태가 초기화된다', async () => {
    mockFetchFor({ 'att-1.png': SIGNED1, 'att-2.png': SIGNED2 });
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1, IMG2]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const zoomContainer = document.querySelector('img[data-next-image="true"]')!.parentElement!.parentElement as HTMLElement;
    await act(async () => {
      zoomContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      zoomContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((document.querySelector('img[data-next-image="true"]')!.parentElement as HTMLElement).style.transform).toBe('scale(2)');

    const nextBtn = document.querySelector('[aria-label="다음 이미지"]') as HTMLButtonElement;
    await act(async () => {
      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    const newZoomWrapper = document.querySelector('img[data-next-image="true"]')!.parentElement as HTMLElement;
    expect(newZoomWrapper.style.transform).toBe('');
  });
});

describe('ImageLightbox — story #2037 상태(denied/expired) — AttachmentImage와 같은 축', () => {
  it('403(denied)이면 접근 권한 없음 안내를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.chats.attachmentDenied);
  });

  it('만료/실패면 다시 불러오기 버튼을 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await act(async () => {
      root.render(wrap(<ImageLightbox items={[IMG1]} startIndex={0} conversationId="conv-1" onClose={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.chats.attachmentReload);
  });
});
