// @vitest-environment jsdom
//
// story a15cea4f — 산출물 갤러리 회귀가드. fetch를 4축 lookup + artifacts로 스텁해 실 렌더를
// 검증(mock 컴포넌트 없음, useDashboardContext만 스텁 — 라우팅 컨텍스트 무관하게 projectId 고정).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactGalleryView } from './artifact-gallery-view';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

const ARTIFACTS = [
  { id: 'a1', title: '웰컴 이메일 시안', story_id: null, epic_id: 'e1', doc_id: null, source: 'created', latest_version_number: 3, anchor_version: 3, created_by: 'm1', created_at: '2026-07-01T00:00:00Z' },
  { id: 'a2', title: '배너 세트 A', story_id: null, epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: 'm1', created_at: '2026-07-01T00:00:00Z' },
];

function stubFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/visual-artifacts/')) return jsonRes([{ id: 'v1', version_number: 1, summary: '초안 레이아웃', created_by: 'm1', created_at: '', source_comment_id: null }]);
    if (url.startsWith('/api/visual-artifacts')) return jsonRes(ARTIFACTS);
    if (url.startsWith('/api/epics')) return jsonRes([{ id: 'e1', title: '온보딩 캠페인' }]);
    if (url.startsWith('/api/stories')) return jsonRes([]);
    if (url.startsWith('/api/sprints')) return jsonRes([]);
    if (url.startsWith('/api/docs')) return jsonRes([]);
    return jsonRes(null);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', stubFetch());
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactGalleryView />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ArtifactGalleryView (story a15cea4f)', () => {
  it('renders the epic axis by default with real group labels and summary chips (no mock data)', async () => {
    await mount();
    expect(container.textContent).toContain('온보딩 캠페인');
    expect(container.textContent).toContain('무소속'); // a2(epic_id=null) 그룹
    expect(container.textContent).toContain('웰컴 이메일 시안');
  });

  it('shows the disabled feature-axis segment with an honest unsupported note (no-fiction — not hidden)', async () => {
    await mount();
    const featureBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '기능');
    expect(featureBtn).toBeDefined();
    expect(featureBtn?.hasAttribute('disabled')).toBe(true);
    expect(featureBtn?.getAttribute('title')).toBe('기능별 모아보기는 아직 지원하지 않습니다');
  });

  it('shows the anchor pill only for artifacts that actually have an anchor version (no fabricated anchors)', async () => {
    await mount();
    expect(container.textContent).toContain('정본 v3');
  });

  it('expanding a row lazily fetches and renders the version timeline (no author, no counts, no elapsed time)', async () => {
    await mount();
    const row = container.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('초안 레이아웃');
    // 감시 금지: 작성자/횟수/경과시간이 렌더되지 않는다.
    expect(container.textContent).not.toContain('m1');
  });

  // story ca37b2b0 — dev 실데이터 재현: 산출물은 story_id만 있고 epic_id는 NULL(에이전트 저작
  // 산출물 기본형). story 경유 유도가 없으면 에픽 탭이 전건 무소속으로 떨어지던 근본원인.
  it('resolves the epic through the artifact\'s story when the artifact has no direct epic_id (스토리 경유 유도)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/visual-artifacts/')) return jsonRes([]);
      if (url.startsWith('/api/visual-artifacts')) return jsonRes([
        { id: 'a1', title: '스토리 앵커 산출물', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: 'm1', created_at: '2026-07-01T00:00:00Z' },
      ]);
      if (url.startsWith('/api/epics')) return jsonRes([{ id: 'e1', title: '온보딩 캠페인' }]);
      if (url.startsWith('/api/stories')) return jsonRes([{ id: 's1', title: '웰컴 이메일 스토리', sprint_id: null, epic_id: 'e1' }]);
      if (url.startsWith('/api/sprints')) return jsonRes([]);
      if (url.startsWith('/api/docs')) return jsonRes([]);
      return jsonRes(null);
    }) as unknown as typeof fetch);
    await mount();
    expect(container.textContent).toContain('온보딩 캠페인');
    expect(container.textContent).toContain('스토리 앵커 산출물');
    // 스토리 경유로 해소됐으니 무소속 그룹 자체가 없어야 한다.
    expect(container.textContent).not.toContain('무소속');
  });

  it('renders the empty state when the project has no artifacts at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/visual-artifacts')) return jsonRes([]);
      return jsonRes([]);
    }) as unknown as typeof fetch);
    await mount();
    expect(container.textContent).toContain('아직 모인 산출물이 없습니다');
  });
});
