// @vitest-environment jsdom
//
// story #2803 — pptx 변환 파이프 FE 통합 실마운트 검증. [[feedback-render-test-over-source-grep]]
// 동형: PptxBody가 실제로 convert→sign 왕복을 거쳐 PDF iframe을 렌더하는지, 변환 실패/시간
// 초과 시 정직 폴백(빈 화면/무한 로딩 금지)으로 빠지는지, assetId 없는 첨부는 애초에 네트워크
// 호출 없이 "준비 중"으로 정직 축소되는지를 실제 마운트로 확인한다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileViewer } from './file-viewer';
import type { ReadingPanelTarget } from './reading-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));
vi.mock('@/lib/native-shell-bridge', () => ({
  downloadAsset: vi.fn(),
  openExternal: vi.fn(),
}));

const ORIGINAL_ASSET_ID = 'orig-asset-2803';
const CONVERTED_ASSET_ID = 'converted-asset-2803';

const target: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
  kind: 'attachment',
  label: 'deck.pptx',
  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  assetId: ORIGINAL_ASSET_ID,
};

let container: HTMLDivElement;
let root: Root;

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// story #2807 — 변환된 PDF는 이제 서명 URL을 곧장 iframe src에 넣지 않고(CSP frame-src
// 'none'에 막힘) fetch→Blob→객체 URL로 바꿔서 건다. jsdom엔 URL.createObjectURL이 없어
// 스텁하고, plain fetch(fetchWithAuth 아님)도 별도로 모킹해야 이 단계를 테스트로 통과시킬 수 있다.
let objectUrlCounter = 0;
const fetchMock = vi.fn();

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchWithAuthMock.mockReset();
  fetchMock.mockReset();
  objectUrlCounter = 0;
});

describe('FileViewer pptx (story #2803)', () => {
  it('실 convert→sign 왕복을 거쳐 반환된 PDF asset을 iframe으로 렌더한다', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${ORIGINAL_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/original.pptx' } });
      }
      if (url.includes('/api/attachments/convert') && init?.method === 'POST') {
        expect(url).toContain(`asset_id=${ORIGINAL_ASSET_ID}`);
        return jsonResponse({ data: { asset_id: CONVERTED_ASSET_ID, name: 'deck.pdf', content_type: 'application/pdf' } });
      }
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${CONVERTED_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/deck.pdf' } });
      }
      throw new Error(`unexpected fetchWithAuth call: ${url}`);
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://signed.example/deck.pdf') return new Response(new Blob(['%PDF-fake']), { status: 200 });
      throw new Error(`unexpected plain fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:mock-${objectUrlCounter++}`),
      revokeObjectURL: vi.fn(),
    }));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.querySelector('iframe') !== null || container.textContent!.includes('변환에 실패했습니다'));

    const iframe = container.querySelector('iframe');
    expect(iframe, `iframe 없음. text=${container.textContent}`).not.toBeNull();
    expect(iframe!.getAttribute('src')).toBe('blob:mock-0');
    // "변환 중" 스피너는 사라져야 한다.
    expect(container.textContent).not.toContain('변환 중입니다');
  });

  it('확장자 .pptx인데 content-type이 wordprocessingml(불일치)이어도 확장자 우선으로 pptx 분기를 탄다(까디르군 QA #2803)', async () => {
    const mismatchedTarget: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
      kind: 'attachment',
      label: 'mismatched.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      assetId: ORIGINAL_ASSET_ID,
    };
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${ORIGINAL_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/mismatched.pptx' } });
      }
      if (url.includes('/api/attachments/convert') && init?.method === 'POST') {
        return jsonResponse({ data: { asset_id: CONVERTED_ASSET_ID, name: 'deck.pdf', content_type: 'application/pdf' } });
      }
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${CONVERTED_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/deck.pdf' } });
      }
      throw new Error(`unexpected fetchWithAuth call: ${url}`);
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://signed.example/deck.pdf') return new Response(new Blob(['%PDF-fake']), { status: 200 });
      throw new Error(`unexpected plain fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:mock-${objectUrlCounter++}`),
      revokeObjectURL: vi.fn(),
    }));

    mount(<FileViewer target={mismatchedTarget} onClose={() => {}} />);
    // pptx로 갔다면 "변환 중" 표시를 거쳐 iframe이 뜬다. docx로 잘못 갔다면 window.fetch(미모킹)
    // 호출이 던져 실패로 빠진다 — 둘 중 하나로 갈릴 때까지 기다려 실제로 pptx 경로임을 증명.
    await waitFor(() => container.querySelector('iframe') !== null || container.textContent!.includes('실패'));

    const iframe = container.querySelector('iframe');
    expect(iframe, `iframe 없음(=docx로 오라우팅됐을 가능성). text=${container.textContent}`).not.toBeNull();
    expect(iframe!.getAttribute('src')).toBe('blob:mock-0');
  });

  it('변환 서비스 미배선(503)이면 정직 폴백으로 빠진다 — 빈 화면/무한 로딩 금지', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${ORIGINAL_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/original.pptx' } });
      }
      if (url.includes('/api/attachments/convert') && init?.method === 'POST') {
        return jsonResponse({ error: { message: '503' } }, 503);
      }
      throw new Error(`unexpected fetchWithAuth call: ${url}`);
    });

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.textContent!.includes('변환에 실패했습니다'));

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.textContent).toContain('다운로드해 확인하세요');
  });

  it('assetId 없는 첨부는 네트워크 호출 없이 "준비 중"으로 정직 축소된다', async () => {
    const legacyTarget: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
      kind: 'attachment',
      label: 'legacy.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/attachments/sign')) return jsonResponse({ data: { url: 'https://signed.example/legacy.pptx' } });
      throw new Error(`unexpected fetchWithAuth call for legacy target: ${url}`);
    });

    mount(<FileViewer target={legacyTarget} onClose={() => {}} />);
    await waitFor(() => container.textContent!.includes('미리보기 준비 중입니다'));

    expect(fetchWithAuthMock.mock.calls.some((call) => String(call[0]).includes('/convert'))).toBe(false);
  });

  it('fetch가 응답하지 않고 멈춰도(hang) 상한 타이머로 정직 폴백에 도달한다 — 무한 로딩 금지', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${ORIGINAL_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/original.pptx' } });
      }
      // convert 요청만 영원히 응답하지 않음(hang 시뮬레이션).
      return new Promise(() => {});
    });

    mount(<FileViewer target={target} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('변환 중입니다');

    await act(async () => { await vi.advanceTimersByTimeAsync(130000); });

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('변환에 실패했습니다');
    vi.useRealTimers();
  });

  it('상한 타이머로 failed 확정 후 convert가 뒤늦게 성공해도 상태가 되돌아가지 않는다(cancelled 레이스 가드)', async () => {
    let resolveConvert: (res: Response) => void = () => {};
    const pendingConvert = new Promise<Response>((resolve) => { resolveConvert = resolve; });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${ORIGINAL_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/original.pptx' } });
      }
      if (url.includes('/api/attachments/convert') && init?.method === 'POST') {
        return pendingConvert;
      }
      if (url.includes('/api/attachments/sign') && url.includes(`asset_id=${CONVERTED_ASSET_ID}`)) {
        return jsonResponse({ data: { url: 'https://signed.example/deck.pdf' } });
      }
      throw new Error(`unexpected fetchWithAuth call: ${url}`);
    });

    mount(<FileViewer target={target} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(130000); });
    expect(container.textContent).toContain('변환에 실패했습니다');

    // failed 확정 후에야 convert가 뒤늦게 성공 응답으로 resolve — 나머지(sign) 왕복이 실제로
    // 흘러도 이미 확정된 failed를 되돌리면 안 된다.
    vi.useRealTimers();
    await act(async () => {
      resolveConvert(jsonResponse({ data: { asset_id: CONVERTED_ASSET_ID, name: 'deck.pdf', content_type: 'application/pdf' } }));
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(container.textContent).toContain('변환에 실패했습니다');
    expect(container.querySelector('iframe')).toBeNull();
  });
});
