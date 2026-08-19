// @vitest-environment jsdom
//
// story #2788 — docx-preview 클라 렌더 실마운트 검증. [[feedback-render-test-over-source-grep]]
// 동형: FileViewerBody가 실제로 docx 바이트를 renderAsync에 먹여 DOM을 채우는지, 그리고
// 렌더 실패 시 정직 폴백(빈 화면/무한 로딩 금지)으로 빠지는지를 실제 마운트로 확인한다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileViewer } from './file-viewer';
import type { ReadingPanelTarget } from './reading-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () =>
    new Response(JSON.stringify({ data: { url: 'https://signed.example/fixture-2788.docx' } }), { status: 200 })
  ),
}));
vi.mock('@/lib/native-shell-bridge', () => ({
  downloadAsset: vi.fn(),
  openExternal: vi.fn(),
}));

const FIXTURE_PATH = join(import.meta.dirname, '__fixtures__/docx-preview-2788.docx');
const REAL_DOCX_BYTES = readFileSync(FIXTURE_PATH);

const target: Extract<ReadingPanelTarget, { kind: 'attachment' }> = {
  kind: 'attachment',
  label: 'fixture-2788.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  assetId: 'asset-2788',
};

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(node); });
}

// dynamic import('docx-preview') + JSZip 파싱은 실제 비동기 작업이라 고정 microtask 횟수로는
// 못 맞춘다 — 조건 충족까지 실제 타이머로 폴링(최대 5초, [[feedback-verify-boring-cause-before-race]]
// 동형: "몇 번 돌리면 되겠지" 추측 대신 실제 완료 신호를 기다린다).
async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer docx (story #2788)', () => {
  it('실물 docx(서식+표 포함)를 실제로 renderAsync에 먹여 DOM에 렌더한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://signed.example/fixture-2788.docx') {
        return new Response(new Uint8Array(REAL_DOCX_BYTES), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.querySelector('.docx-preview-container') !== null || container.textContent!.includes('표시하지 못했습니다'));

    const docxContainer = container.querySelector('.docx-preview-container');
    expect(docxContainer).not.toBeNull();
    // 실제 문서 텍스트(표 셀+마커 문단)가 DOM에 나타났는지 — 가짜 렌더가 아니라 실제
    // XML→DOM 변환이 일어났다는 증거.
    expect(container.textContent).toContain('DOCX_RENDER_MARKER_OK');
    expect(container.textContent).toContain('docx-preview');
    expect(container.textContent).toContain('굵게 표시된 부분');
    // 로딩 스켈레톤은 사라져야 한다.
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('손상된 docx는 정직 폴백(빈 화면/무한 로딩 금지)으로 빠진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.textContent!.includes('표시하지 못했습니다'));

    expect(container.querySelector('.docx-preview-container')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.textContent).toContain('미리보기를 표시하지 못했습니다');
    expect(container.textContent).toContain('다운로드');
  });
});
