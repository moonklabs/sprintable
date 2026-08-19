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
// 못 맞춘다 — 조건 충족까지 실제 타이머로 폴링(최대 20초, CI 공유 러너의 저사양 여유분
// 포함, [[feedback-verify-boring-cause-before-race]] 동형: "몇 번 돌리면 되겠지" 추측
// 대신 실제 완료 신호를 기다린다).
async function waitFor(check: () => boolean, timeoutMs = 20000) {
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
    const renderErrors: unknown[][] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { renderErrors.push(args); });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://signed.example/fixture-2788.docx') {
        return new Response(new Uint8Array(REAL_DOCX_BYTES), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await waitFor(() => container.querySelector('.docx-preview-container') !== null || container.textContent!.includes('표시하지 못했습니다'));

    const docxContainer = container.querySelector('.docx-preview-container');
    // 실패 시 콘솔에 남긴 실제 원인을 단언 메시지에 실어 CI 로그에서 바로 보이게 한다
    // (여기서 막혔다면 tail -80이 그 뒤 상세를 잘라먹을 수 있어 — 원인 텍스트 자체를 이 줄에 노출).
    expect(docxContainer, `docx-preview-container 없음. console.error: ${JSON.stringify(renderErrors)}`).not.toBeNull();
    errorSpy.mockRestore();
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

  it('fetch가 응답하지 않고 멈춰도(hang) 상한 타이머로 정직 폴백에 도달한다 — 무한 로딩 금지(story #2788 QA 지적)', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    mount(<FileViewer target={target} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });

    expect(container.querySelector('.docx-preview-container')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.textContent).toContain('미리보기를 표시하지 못했습니다');
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('renderAsync가 진행 중일 때 timeout이 먼저 발화해도, 뒤늦게 끝난 렌더가 확정된 failed를 되돌리지 않는다(story #2788 QA 재발견 — cancelled 미설정 레이스)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveRender: () => void = () => {};
    const pendingRender = new Promise<void>((resolve) => { resolveRender = resolve; });
    const renderAsyncSpy = vi.fn(async (_data: unknown, el: HTMLElement) => {
      // renderAsync가 실제로 시작돼 containerRef를 이미 붙잡았음을 표시 — Kadir 지적의
      // 전제(fetch 대기 중이 아니라 렌더 진행 중에 timeout이 발화)를 재현하는 지점.
      el.setAttribute('data-render-started', 'true');
      await pendingRender;
      el.textContent = 'PHANTOM_LATE_RENDER';
    });
    vi.resetModules();
    vi.doMock('docx-preview', () => ({ renderAsync: renderAsyncSpy }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(REAL_DOCX_BYTES), { status: 200 })));

    // 이 시나리오는 20초 상한 타이머 자체가 fake여야 하므로(마운트 시점에 컴포넌트가
    // setTimeout(20000)을 예약한다) mount 전에 fake timer를 켠다. fetch~dynamic
    // import~renderAsync 진입은 순수 microtask 체인이라 실제 시간 없이도 진행되므로,
    // 0ms 어드밴스를 반복해 마이크로태스크 큐를 배출하며 renderAsync 호출을 기다린다.
    vi.useFakeTimers();
    mount(<FileViewer target={target} onClose={() => {}} />);
    for (let i = 0; i < 50 && renderAsyncSpy.mock.calls.length === 0; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
    expect(renderAsyncSpy).toHaveBeenCalled();

    // renderAsync가 pendingRender를 기다리며 멈춰 있는 도중 20초 상한 타이머가 발화 —
    // failed 확정.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(container.textContent).toContain('미리보기를 표시하지 못했습니다');
    vi.useRealTimers();

    // 이제야 renderAsync가 뒤늦게 완료 — run 꼬리의 setStatus('ready')가 이미 확정된
    // failed를 되돌리면 안 된다(cancelled를 catch에서 세우지 않았을 때의 실제 버그).
    await act(async () => {
      resolveRender();
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(container.textContent).toContain('미리보기를 표시하지 못했습니다');
    expect(container.querySelector('.docx-preview-container')).toBeNull();
    errorSpy.mockRestore();
    vi.doUnmock('docx-preview');
    vi.resetModules();
  });
});
