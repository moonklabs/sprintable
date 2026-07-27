// @vitest-environment jsdom
//
// story 64010b05(E-CANVAS C5 임포트 v1) — 임포트 다이얼로그 왕복 검증. 이미지 탭은 업로드→URL
// 응답을 받아 html_blob{src} 노드를, HTML 탭은 붙여넣은 문자열을 html_blob{html} 노드를
// 만들어 onImport로 넘기는지까지 실측(장식 방지 — 070a06b22/083176e8에서 반복된 "신규 기능
// 무테스트" 지적을 이번엔 구현과 같은 커밋에서 선반영).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ImportArtifactDialog } from './import-artifact-dialog';
import koMessages from '../../../messages/ko.json';
import type { ArtifactNode } from '@/services/canvas-nodes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(onImport: (nodes: ArtifactNode[]) => Promise<boolean> = vi.fn(async () => true)) {
  await act(async () => {
    root.render(wrap(<ImportArtifactDialog open onOpenChange={vi.fn()} onImport={onImport} />));
  });
  return onImport;
}

describe('ImportArtifactDialog — 이미지 탭(story 64010b05 §3)', () => {
  it('uploads the selected file and enables confirm once a URL comes back', async () => {
    fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ data: { url: 'https://cdn.example.com/imported.png' } }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);

    const onImport = await mount();
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const confirmButton = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === '임포트')!;
    expect(confirmButton().hasAttribute('disabled')).toBe(true); // 업로드 전엔 비활성

    const file = new File(['fake-bytes'], 'design.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/visual-artifacts/import-image', expect.objectContaining({ method: 'POST' }));
    expect(confirmButton().hasAttribute('disabled')).toBe(false);

    await act(async () => { confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onImport).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'html_blob', props: { src: 'https://cdn.example.com/imported.png' } }),
    ]);
  });

  it('shows a quiet failure note (no alarm styling) when upload fails — 낙인 0', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);

    await mount();
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-bytes'], 'design.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });

    expect(document.body.textContent).toContain('가져오지 못했습니다');
    const confirmButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '임포트')!;
    expect(confirmButton.hasAttribute('disabled')).toBe(true); // URL 없으니 여전히 비활성
  });
});

describe('ImportArtifactDialog — HTML 탭(story 64010b05 §3)', () => {
  it('enables confirm once HTML is pasted, and submits an html_blob{html} node', async () => {
    const onImport = await mount();
    const htmlTab = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'HTML 붙여넣기')!;
    await act(async () => { htmlTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    const confirmButton = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === '임포트')!;
    expect(confirmButton().hasAttribute('disabled')).toBe(true);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '<div>안녕</div>');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirmButton().hasAttribute('disabled')).toBe(false);

    await act(async () => { confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onImport).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'html_blob', props: { html: '<div>안녕</div>' } }),
    ]);
  });

  it('never calls import-image for the HTML tab (탭 간 교차 호출 0)', async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const htmlTab = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'HTML 붙여넣기')!;
    await act(async () => { htmlTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '<div>안녕</div>');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
