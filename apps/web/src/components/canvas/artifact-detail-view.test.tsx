// @vitest-environment jsdom
//
// story #2713 — standalone 아티팩트 상세 진입점 회귀가드. storyId 없이 단건 fetch만으로
// ArtifactViewer가 뜨는지(양성)와, 존재하지 않는/접근 불가 id면 not-found 상태로 빠지는지
// (음성) 둘 다 확認 — ArtifactSection의 story-scoped 로더를 재사용하는 것이라 로더 자체의
// 정상/에러 분기 로직은 artifact-section.test.tsx가 이미 커버, 여기선 "storyId 없이도
// 뜬다"는 이 컴포넌트 고유의 결합만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactDetailView } from './artifact-detail-view';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(artifactId: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactDetailView artifactId={artifactId} />
      </NextIntlClientProvider>,
    );
  });
  // detail → (comments·versions·pins·gates) 순차 fetch 체인 플러시.
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
  });
}

function stubFetch(detailOk: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/pins')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    // story #2721(별건, 이번 판 사이 develop에 머지) — ArtifactViewer가 이제 EntityBacklinksSection도
    // 그려 `/backlinks`를 fetch한다. `/comments`보다 먼저 걸러야 한다(문자열 포함 검사라 순서 무관하지만
    // 명시적으로 분리 — items 배열 형상 계약이 detail 폴백과 달라 섞이면 items.filter 크래시).
    if (url.includes('/backlinks')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/versions')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
    // 단건 상세 — storyId/epic_id/doc_id 전부 null(standalone, 이 스토리의 핵심 실증 대상).
    if (!detailOk) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({
        data: {
          id: 'artifact-1', title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
          source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
          created_at: '2026-08-17T00:00:00Z', version_number: 1, version_summary: null, nodes: [],
        },
      }),
    };
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
}

describe('ArtifactDetailView — standalone 상세(story #2713)', () => {
  it('storyId 없이 artifactId만으로 ArtifactViewer가 뜬다(양성)', async () => {
    stubFetch(true);
    await mount('artifact-1');
    expect(container.textContent).toContain('흐름판 재설계 시안');
    expect(container.textContent).toContain('갤러리로 돌아가기');
  });

  it('404(미존재/접근 불가)면 not-found 상태로 빠진다 — existence-non-disclosure 그대로 상속', async () => {
    stubFetch(false);
    await mount('artifact-missing');
    expect(container.textContent).toContain('산출물을 찾을 수 없습니다');
    expect(container.textContent).not.toContain('갤러리로 돌아가기');
  });
});

describe('ArtifactDetailView — 새 좌표 코멘트 생성(story #2725, standalone 표면)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON() { return {}; },
    } as DOMRect);
  });
  afterEach(() => { rectSpy.mockRestore(); });

  it('picking a coordinate and submitting POSTs anchor_x/anchor_y (no parent_id) — storyId 없는 표면에서도 도달성 성립', async () => {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pins')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/backlinks')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/comments') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return { ok: true, status: 201, json: async () => ({ data: {} }) };
      }
      if (url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/versions')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            id: 'artifact-1', title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
            source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
            created_at: '2026-08-17T00:00:00Z', version_number: 1, version_summary: null, nodes: [],
          },
        }),
      };
    }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);

    await mount('artifact-1');

    const toggle = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    await act(async () => {
      viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 128, clientY: 80, button: 0 }));
      viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 128, clientY: 80 }));
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '여기 확인 부탁');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '코멘트')!;
    await act(async () => { submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(posted).toHaveLength(1);
    const body = posted[0] as { content: string; anchor_x: number; anchor_y: number; parent_id?: string };
    expect(body.content).toBe('여기 확인 부탁');
    expect(body.anchor_x).toBeCloseTo(10, 5); // 128/1280*100
    expect(body.anchor_y).toBeCloseTo(10, 5); // 80/800*100
    expect(body.parent_id).toBeUndefined();
  });
});
