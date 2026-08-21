// @vitest-environment jsdom
//
// story #2807 — PdfBody가 서명 GCS URL을 곧장 iframe src에 넣지 않고(CSP frame-src 'none'에
// 막힘, 선생님 실측 ERR_BLOCKED_BY_CSP) fetch→Blob→객체 URL로 바꿔 iframe에 거는지 실마운트로
// 확인한다. [[feedback-render-test-over-source-grep]] 동형 — 소스만 보고 "blob URL 쓴다"고
// 서술하는 대신 실제로 iframe의 src가 blob:인지, 실패 시 정직 폴백에 도달하는지를 확인한다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileViewer } from './file-viewer';
import type { ReadingPanelTarget } from './reading-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () =>
    new Response(JSON.stringify({ data: { url: 'https://signed.example/fixture.pdf' } }), { status: 200 })
  ),
}));
vi.mock('@/lib/native-shell-bridge', () => ({
  downloadAsset: vi.fn(),
  openExternal: vi.fn(),
}));

const target: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
  kind: 'attachment',
  label: 'fixture.pdf',
  contentType: 'application/pdf',
  assetId: 'asset-pdf',
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

describe('FileViewer pdf (story #2807 — CSP frame-src blob 전환)', () => {
  it('서명 URL을 fetch→Blob→객체 URL로 바꿔 iframe src에 건다(외부 호스트 URL을 곧장 안 씀)', async () => {
    stubObjectUrl();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // story #2807 CI 재발견 — new Response(new Blob([...]))는 Node 22(CI)에서
      // "object.stream is not a function"으로 깨진다(undici Response 생성자가 cross-realm
      // Blob의 .stream()을 못 찾는 버전차, 로컬 Node 26에선 안 재현됨). 문자열 body로 우회.
      if (url === 'https://signed.example/fixture.pdf') return new Response('%PDF-fake', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.querySelector('iframe') !== null || container.textContent!.includes('표시하지 못했습니다'));

    const iframe = container.querySelector('iframe');
    expect(iframe, `iframe 없음. text=${container.textContent}`).not.toBeNull();
    expect(iframe!.getAttribute('src')).toBe('blob:mock-0');
    // 서명 URL(외부 호스트)을 그대로 src에 넣지 않는다 — CSP frame-src가 blob:만 허용.
    expect(iframe!.getAttribute('src')).not.toContain('signed.example');
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
