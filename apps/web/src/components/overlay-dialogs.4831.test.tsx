// @vitest-environment jsdom
//
// story 4831 덮개 ③ — 크게 보기 창(ArtifactExpandDialog) · 명령 팔레트(CommandPalette) · 채팅 이미지 확대(ImageLightbox)는 base-ui Dialog 원시 부품 위에 서 있다.
// 이 세 곳의 가림막이 «손으로 쓴 fixed inset-0»가 아니라 바탕 Dialog 부품(DialogOverlay)을 쓰고, 루트가 바탕 Dialog(한 Esc = 한 층 보호)인지 결과로 잠근다.
//   ① 특성화(옮기기 전 동작 그대로): 열리면 role=dialog · 가림막 토큰 · Esc로 닫힌다
//   ② 바탕 Dialog를 거친 뒤의 동작(옮긴 뒤에만 참): 가림막이 dialog-overlay 부품 · 한글 조합 중 Esc와 안쪽 층이 쓴 Esc는 창을 닫지 않는다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { ArtifactExpandDialog } from './canvas/artifact-expand-dialog';
import { CommandPalette } from './command-palette/command-palette';
import { ImageLightbox } from './chat/image-lightbox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: 'https://files.example/a.png' } }) })));
  window.history.replaceState(null, '', window.location.pathname);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.querySelectorAll('[data-slot="dialog-content"], [data-base-ui-popup], [role="dialog"]').forEach((n) => n.remove());
  vi.unstubAllGlobals();
});

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);
const backdrop = (scrim: string) => [...document.body.querySelectorAll('div')].find((d) => hasClass(d, scrim) && hasClass(d, 'fixed') && hasClass(d, 'inset-0')) as HTMLElement | undefined;
const esc = async (target: EventTarget = document, init: KeyboardEventInit = {}) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })); });
  await settle();
};

type Case = { name: string; scrim: string; mount: (onClose: () => void) => React.ReactNode; closed: (onClose: ReturnType<typeof vi.fn>) => boolean; extra?: string[] };
const CASES: Case[] = [
  {
    name: '크게 보기 창(ArtifactExpandDialog)',
    scrim: 'bg-scrim-1',
    mount: (onClose) => <ArtifactExpandDialog open onOpenChange={(o) => { if (!o) onClose(); }} title="t" format="html" content="<div>hi</div>" canvasBounds={{ w: 1280, h: 800 }} />,
    closed: (f) => f.mock.calls.length >= 1,
  },
  {
    name: '명령 팔레트(CommandPalette)',
    scrim: 'bg-scrim-1',
    mount: (onClose) => <CommandPalette open onOpenChange={(o) => { if (!o) onClose(); }} />,
    closed: (f) => f.mock.calls.length >= 1,
    extra: ['supports-backdrop-filter:backdrop-blur-xs'],
  },
  {
    name: '채팅 이미지 확대(ImageLightbox)',
    scrim: 'bg-scrim-3',
    mount: (onClose) => <ImageLightbox items={[{ storedUrl: 'att-1.png', alt: '사진1' }]} startIndex={0} conversationId="conv-1" onClose={onClose} />,
    closed: (f) => f.mock.calls.length >= 1,
  },
];

describe.each(CASES)('① 특성화 — $name', (c) => {
  it('열리면 role=dialog이고 가림막이 전체 화면 토큰(' + 'scrim' + ')을 갖는다', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(c.mount(onClose))); });
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    const b = backdrop(c.scrim);
    expect(b, `${c.scrim} 가림막`).toBeDefined();
    for (const t of c.extra ?? []) expect(hasClass(b!, t), t).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
  it('Esc를 누르면 닫힌다(안쪽 층도 조합도 없을 때)', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(c.mount(onClose))); });
    await settle();
    await esc();
    expect(c.closed(onClose)).toBe(true);
  });
});

describe.each(CASES)('② 바탕 Dialog를 거친 뒤 — $name', (c) => {
  it('가림막이 바탕 dialog-overlay 부품이다(손으로 쓴 fixed inset-0가 아님)', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(c.mount(onClose))); });
    await settle();
    const overlay = document.body.querySelector('[data-slot="dialog-overlay"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(hasClass(overlay!, c.scrim)).toBe(true);
    expect(hasClass(overlay!, 'fixed') && hasClass(overlay!, 'inset-0')).toBe(true); // 전체 화면 가림은 부품이 가진다
    expect(hasClass(overlay!, 'bg-scrim-2')).toBe(false); // 부품 기본 가림막 색을 호출부 토큰이 이긴다
  });
  it('한글 조합 중의 Esc는 창을 닫지 않는다(조합만 취소 — 한 Esc = 한 층 보호)', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(c.mount(onClose))); });
    await settle();
    await esc(document, { isComposing: true });
    await esc(document, { keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    await esc(); // 조합이 끝난 Esc는 닫는다
    expect(c.closed(onClose)).toBe(true);
  });
  it('안쪽 층이 이미 쓴 Esc(preventDefault)는 창을 닫지 않는다', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(c.mount(onClose))); });
    await settle();
    const popup = document.body.querySelector('[role="dialog"]') as HTMLElement;
    popup.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    await esc(popup);
    expect(onClose).not.toHaveBeenCalled();
    await esc(popup); // 표시가 없는 다음 Esc는 닫는다
    expect(c.closed(onClose)).toBe(true);
  });
});

describe('명령 팔레트 — 검색 칸에 글이 있는 상태의 첫 Esc(바탕 Dialog의 Esc 보호가 이 길을 바꾸지 않는다)', () => {
  it('글을 쓴 뒤 검색 칸에서 누른 Esc가 첫 번째에 창을 닫는다', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(<CommandPalette open onOpenChange={(o) => { if (!o) onClose(); }} />)); });
    await settle();
    const input = document.body.querySelector('input[role="combobox"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '문서');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await esc(input);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('글이 없는 검색 칸에서 누른 Esc도 첫 번째에 닫는다', async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(wrap(<CommandPalette open onOpenChange={(o) => { if (!o) onClose(); }} />)); });
    await settle();
    const input = document.body.querySelector('input[role="combobox"]') as HTMLInputElement;
    await esc(input);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
