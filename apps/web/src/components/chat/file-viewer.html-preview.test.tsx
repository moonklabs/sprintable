// @vitest-environment jsdom
//
// story #2809 — HtmlPreviewBody가 서명 GCS URL을 곧장 iframe src에 넣지 않고(CSP frame-src
// blob:만 허용, 2807과 동일 근본원인) fetch→Blob→객체 URL로 바꿔 iframe에 거는지, sandbox
// 격리(allow-popups만·allow-scripts 없음)가 그대로 유지되는지 실마운트로 확인한다.
// [[feedback-render-test-over-source-grep]] 동형.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileViewer } from './file-viewer';
import type { ReadingPanelTarget } from './reading-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () =>
    new Response(JSON.stringify({ data: { url: 'https://signed.example/fixture.html' } }), { status: 200 })
  ),
}));
vi.mock('@/lib/native-shell-bridge', () => ({
  downloadAsset: vi.fn(),
  openExternal: vi.fn(),
}));

const target: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
  kind: 'attachment',
  label: 'fixture.html',
  contentType: 'text/html',
  assetId: 'asset-html',
};

let container: HTMLDivElement;
let root: Root;
let objectUrlCounter = 0;

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(node); });
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

function stubObjectUrl() {
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:mock-${objectUrlCounter++}`),
    revokeObjectURL: vi.fn(),
  }));
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  objectUrlCounter = 0;
});

describe('FileViewer html (story #2809 — CSP frame-src blob 전환)', () => {
  it('서명 URL을 fetch→Blob→객체 URL로 바꿔 iframe src에 걸고, sandbox 격리를 유지한다', async () => {
    stubObjectUrl();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://signed.example/fixture.html') return new Response('<h1>hi</h1>', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.querySelector('iframe') !== null || container.textContent!.includes('표시하지 못했습니다'));

    const iframe = container.querySelector('iframe');
    expect(iframe, `iframe 없음. text=${container.textContent}`).not.toBeNull();
    expect(iframe!.getAttribute('src')).toBe('blob:mock-0');
    expect(iframe!.getAttribute('src')).not.toContain('signed.example');
    // 격리 유지 — allow-scripts/allow-same-origin은 여전히 없어야 한다(미신뢰 콘텐츠).
    expect(iframe!.getAttribute('sandbox')).toBe('allow-popups');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('fetch가 실패(404)하면 정직 폴백으로 빠진다 — 빈 화면/무한 로딩 금지', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.textContent!.includes('표시하지 못했습니다'));

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('다운로드해 확인하세요');
  });

  it('fetch가 응답하지 않고 멈춰도(hang) 상한 타이머로 정직 폴백에 도달한다 — 무한 로딩 금지', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('표시하지 못했습니다');
    errorSpy.mockRestore();
    vi.useRealTimers();
  });
});
