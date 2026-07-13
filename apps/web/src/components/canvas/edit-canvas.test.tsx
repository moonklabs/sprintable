// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { EditCanvas } from './edit-canvas';
import type { ResolvedNode } from '@/services/canvas-nodes';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

/** 툴바 버튼("스펙 핀 추가")을 제외한 나머지 <button> 마크업만 — NodeBox 버튼만 검증 대상. */
function nodeButtonsOnly(markup: string) {
  return markup.split('<button').slice(1).filter((b) => !b.includes('스펙 핀 추가'));
}

describe('EditCanvas (C3 §2 — 클릭 선택만, 중첩 트리 재귀 렌더, story 1948d19d §3 — CanvasViewport 통합)', () => {
  it('renders nested children indented under their parent', () => {
    const tree: ResolvedNode[] = [
      {
        id: 'root', type: 'Container', props: {}, parent_id: null, sort_order: 0,
        children: [
          { id: 'child1', type: 'Text', props: { text: '안내 문구' }, parent_id: 'root', sort_order: 0, children: [] },
        ],
      },
    ];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('Container');
    expect(markup).toContain('Text');
    expect(markup).toContain('안내 문구');
  });

  it('falls back to the node type as the label when props.text is missing', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('Card');
  });

  it('applies the selected ring style only to the node matching selectedId', () => {
    const tree: ResolvedNode[] = [
      { id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] },
      { id: 'n2', type: 'Button', props: {}, parent_id: null, sort_order: 1, children: [] },
    ];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId="n2" onSelect={vi.fn()} />));
    const buttons = nodeButtonsOnly(markup);
    expect(buttons[0]).not.toContain('ring-primary/40');
    expect(buttons[1]).toContain('ring-primary/40');
  });

  it('mounts the node tree on the shared CanvasViewport engine (edit mode — no duplicate inert TreeStageContent)', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('data-artifact-canvas-viewport');
    expect(markup).toContain('data-artifact-canvas-overlay');
    // fit/actual-size chrome renders too (edit mode still gets pan/zoom, per §3 "큰 뷰포트").
    expect(markup).toContain('전체 보기');
    expect(markup).toContain('실제 크기');
  });

  it('marks the node list as data-canvas-scrollable (PR#2138 — 긴 트리 내부 스크롤을 캔버스 pan에서 양보받는 마커)', () => {
    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('data-canvas-scrollable');
  });

  it('disables the spec-pin tool when artifactId is absent (creating a brand-new artifact)', () => {
    const tree: ResolvedNode[] = [];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} />));
    expect(markup).toContain('스펙 핀 추가');
    expect(markup).toContain('disabled=""');
  });

  it('enables the spec-pin tool when artifactId is present', () => {
    const tree: ResolvedNode[] = [];
    const markup = renderToStaticMarkup(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} artifactId="a1" />));
    const toolButton = markup.split('<button').find((b) => b.includes('스펙 핀 추가'));
    expect(toolButton).toBeDefined();
    expect(toolButton).not.toContain('disabled=""');
  });
});

describe('EditCanvas — 스펙 핀 저작 왕복 (story 7fe16274, doc artifact-pin-authoring-spec v1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // fit-on-mount에 필요한 실측 스텁(clientWidth/Height 기본 0인 jsdom 대응, 기존 관례).
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON() { return {}; },
    } as DOMRect);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(artifactId = 'artifact-1') {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pins') && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url.endsWith('/pins') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { anchor_x: number; anchor_y: number; description: string };
        return {
          ok: true, status: 201, json: async () => ({
            data: {
              id: 'pin-1', artifact_id: artifactId, version_id: 'v1', anchor_type: 'coord',
              anchor_x: body.anchor_x, anchor_y: body.anchor_y, node_id: null, description: body.description,
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);

    const tree: ResolvedNode[] = [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0, children: [] }];
    await act(async () => {
      root.render(wrap(<EditCanvas tree={tree} selectedId={null} onSelect={vi.fn()} artifactId={artifactId} />));
    });
    await act(async () => { await Promise.resolve(); }); // listSpecPins 마운트 fetch 플러시
  }

  it('clicking the canvas background while the tool is active opens the draft popover, and saving posts a coord pin', async () => {
    await mount();
    const toolButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '스펙 핀 추가')!;
    await act(async () => { toolButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const catcher = container.querySelector('[data-pin-placement-catcher]') as HTMLDivElement;
    expect(catcher).not.toBeNull();
    await act(async () => { catcher.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 50 })); });

    // 팝오버(base-ui Dialog는 document.body에 포탈)에 textarea가 뜬다.
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const saveButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '저장')!;
    expect(saveButton.hasAttribute('disabled')).toBe(true); // 빈 description = 저장 비활성(§3 커밋 차단)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '헤더는 primary 배경입니다.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(saveButton.hasAttribute('disabled')).toBe(false);

    await act(async () => { saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const postCall = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(postCall).toBeDefined();
    const postBody = JSON.parse(postCall![1].body as string);
    expect(postBody.anchor_type).toBe('coord');
    expect(postBody.description).toBe('헤더는 primary 배경입니다.');
    // 저장 후 팝오버가 닫히고 핀이 캔버스에 반영된다.
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('pressing ESC on an open draft popover discards it without any POST', async () => {
    await mount();
    const toolButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '스펙 핀 추가')!;
    await act(async () => { toolButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const catcher = container.querySelector('[data-pin-placement-catcher]') as HTMLDivElement;
    await act(async () => { catcher.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(document.body.querySelector('textarea')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(document.body.querySelector('textarea')).toBeNull();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });
});
