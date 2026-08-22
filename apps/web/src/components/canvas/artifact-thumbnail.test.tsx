// @vitest-environment jsdom
//
// story #2895(BUG·결재 표면, 선생님 실증) — 회귀가드. object-cover가 "imported" 아티팩트
// (전체 페이지 캡처, 세로로 매우 긴 이미지 — 실측 2480×3560)를 16:9 aspect-video 박스에서
// 심하게 크롭해 「흰 배경으로 깨진」 것처럼 보이게 한 것이 근본원인 — object-contain(크롭 0)
// 으로 전환한 것을 잠근다. jsdom엔 IntersectionObserver가 없어(컴포넌트 자체 설계상 그
// 환경은 lazy 게이트 없이 즉시 inView=true로 시작) 별도 스텁 불요.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactThumbnail } from './artifact-thumbnail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

vi.mock('@/services/canvas-export', () => ({
  listArtifactExports: vi.fn(async () => []),
}));

const getArtifactVersionDetailMock = vi.fn();
vi.mock('@/services/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/canvas')>();
  return { ...actual, getArtifactVersionDetail: (...args: unknown[]) => getArtifactVersionDetailMock(...args) };
});

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
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ArtifactThumbnail — story #2895 object-fit 회귀가드', () => {
  it('"imported" 아티팩트(props.src = 전체 페이지 캡처 URL) — <img>가 object-contain(크롭 0)으로 렌더된다', async () => {
    getArtifactVersionDetailMock.mockResolvedValue({
      id: 'a-1', title: 'S2b 칩 가독성 목업', story_id: null, epic_id: null, doc_id: null,
      source: 'imported', latest_version_number: 1, anchor_version: null, created_by: null,
      created_at: '2026-08-21T08:31:42Z', version_number: 1, version_summary: null,
      canvas_bounds: null,
      nodes: [{ id: 'n-1', type: 'html_blob', props: { src: 'https://storage.googleapis.com/example/tall-capture.png' }, parent_id: null, sort_order: 0, description: null }],
    });
    await act(async () => {
      root.render(wrap(<ArtifactThumbnail artifactId="a-1" latestVersionNumber={1} anchorVersion={null} />));
    });
    await flush();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.className).toContain('object-contain');
    expect(img!.className).not.toContain('object-cover');
    expect(img!.src).toContain('tall-capture.png');
  });

  it('PNG export가 있으면 그 경로도 object-contain으로 렌더된다(export 우선 순위 회귀 0)', async () => {
    const { listArtifactExports } = await import('@/services/canvas-export');
    (listArtifactExports as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { format: 'png', download_url: 'https://storage.googleapis.com/example/export.png' },
    ]);
    getArtifactVersionDetailMock.mockResolvedValue(null);
    await act(async () => {
      root.render(wrap(<ArtifactThumbnail artifactId="a-2" latestVersionNumber={1} anchorVersion={null} />));
    });
    await flush();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.className).toContain('object-contain');
    expect(img!.src).toContain('export.png');
  });

  it('html_blob(자기완결 HTML, props.html) — 여전히 iframe srcDoc으로 렌더된다(회귀 0, img 분기 무영향)', async () => {
    getArtifactVersionDetailMock.mockResolvedValue({
      id: 'a-3', title: '자기완결 HTML', story_id: null, epic_id: null, doc_id: null,
      source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
      created_at: '2026-08-21T08:31:42Z', version_number: 1, version_summary: null,
      canvas_bounds: { w: 1180, h: 1500 },
      nodes: [{ id: 'n-1', type: 'html_blob', props: { html: '<html><body>hi</body></html>' }, parent_id: null, sort_order: 0, description: null }],
    });
    await act(async () => {
      root.render(wrap(<ArtifactThumbnail artifactId="a-3" latestVersionNumber={1} anchorVersion={null} />));
    });
    await flush();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe[srcdoc]')).toBeTruthy();
  });
});
