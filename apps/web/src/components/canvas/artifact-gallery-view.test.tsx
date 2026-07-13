// @vitest-environment jsdom
//
// story a15cea4f — 산출물 갤러리 회귀가드. fetch를 4축 lookup + artifacts로 스텁해 실 렌더를
// 검증(mock 컴포넌트 없음, useDashboardContext만 스텁 — 라우팅 컨텍스트 무관하게 projectId 고정).
//
// story 3d888ba2 — 썸네일(exports/version-detail)이 추가되며 URL 매칭 정밀도가 중요해짐:
// `/api/visual-artifacts/{id}/versions/{n}`(단일 객체)과 `/api/visual-artifacts/{id}/versions`
// (배열)·`/api/visual-artifacts/{id}/exports`(배열)를 startsWith만으로 구분 못 하면 엉뚱한
// shape가 detail 자리에 들어가 `adaptArtifactDetail`이 크래시한다(1차 구현 때 실제로 겪음) —
// 정규식으로 정밀 매칭.
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

const HTML_NODE = { id: 'n1', type: 'html_blob', props: { html: '<div>실물 콘텐츠</div>' } };

function versionDetail(artifactId: string, versionNumber: number, nodes: unknown[] = [HTML_NODE]) {
  return {
    id: artifactId, title: '웰컴 이메일 시안', story_id: null, epic_id: 'e1', doc_id: null,
    source: 'created', latest_version_number: 3, anchor_version: 3, created_by: 'm1',
    created_at: '2026-07-01T00:00:00Z', version_number: versionNumber, version_summary: null, nodes,
  };
}

interface StubOverrides {
  artifacts?: unknown[];
  stories?: unknown[];
  exportsByArtifact?: Record<string, unknown[]>;
  versionDetailByArtifact?: Record<string, unknown>;
}

function stubFetch(overrides: StubOverrides = {}) {
  return vi.fn(async (url: string) => {
    const versionMatch = /^\/api\/visual-artifacts\/([^/]+)\/versions\/(\d+)/.exec(url);
    if (versionMatch) {
      const [, artifactId, versionNumber] = versionMatch;
      const byVersion = overrides.versionDetailByArtifact?.[`${artifactId}:${versionNumber}`];
      const byArtifact = overrides.versionDetailByArtifact?.[artifactId!];
      return jsonRes(byVersion ?? byArtifact ?? null);
    }
    if (/^\/api\/visual-artifacts\/[^/]+\/versions/.exec(url)) {
      return jsonRes([{ id: 'v1', version_number: 1, summary: '초안 레이아웃', created_by: 'm1', created_at: '', source_comment_id: null }]);
    }
    const exportsMatch = /^\/api\/visual-artifacts\/([^/]+)\/exports/.exec(url);
    if (exportsMatch) {
      return jsonRes(overrides.exportsByArtifact?.[exportsMatch[1]!] ?? []);
    }
    if (url.startsWith('/api/visual-artifacts')) return jsonRes(overrides.artifacts ?? ARTIFACTS);
    if (url.startsWith('/api/epics')) return jsonRes([{ id: 'e1', title: '온보딩 캠페인' }]);
    if (url.startsWith('/api/stories')) return jsonRes(overrides.stories ?? []);
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

// 썸네일도 'live' 상태면 자기 iframe[srcdoc]을 갖는다(container 안) — 모달은 base-ui
// Portal로 document.body에 형제로 렌더되니, container 밖의 것만 골라야 모달 iframe이 잡힌다.
function findDialogIframe(): HTMLIFrameElement | undefined {
  return [...document.body.querySelectorAll('iframe[srcdoc]')].find((el) => !container.contains(el)) as HTMLIFrameElement | undefined;
}

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
    vi.stubGlobal('fetch', stubFetch({
      artifacts: [
        { id: 'a1', title: '스토리 앵커 산출물', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: 'm1', created_at: '2026-07-01T00:00:00Z' },
      ],
      stories: [{ id: 's1', title: '웰컴 이메일 스토리', sprint_id: null, epic_id: 'e1' }],
    }));
    await mount();
    expect(container.textContent).toContain('온보딩 캠페인');
    expect(container.textContent).toContain('스토리 앵커 산출물');
    // 스토리 경유로 해소됐으니 무소속 그룹 자체가 없어야 한다.
    expect(container.textContent).not.toContain('무소속');
  });

  it('renders the empty state when the project has no artifacts at all', async () => {
    vi.stubGlobal('fetch', stubFetch({ artifacts: [] }));
    await mount();
    expect(container.textContent).toContain('아직 모인 산출물이 없습니다');
  });
});

describe('ArtifactGalleryView — story 3d888ba2 (실물 열람 + 그리드 시각 프리뷰)', () => {
  it('clicking the thumbnail opens the expand dialog with the real anchor/latest version content', async () => {
    vi.stubGlobal('fetch', stubFetch({
      versionDetailByArtifact: { a1: versionDetail('a1', 3) },
    }));
    await mount();
    const thumbBtn = container.querySelector('[title="산출물 열기"]') as HTMLButtonElement;
    expect(thumbBtn).not.toBeNull();
    await act(async () => { thumbBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // srcDoc은 별도 문서라 document.body.textContent에 안 잡힌다 — iframe 자신의 srcdoc으로 확인.
    const dialogIframe = findDialogIframe();
    expect(dialogIframe).not.toBeUndefined();
    expect(dialogIframe!.srcdoc).toContain('실물 콘텐츠');
  });

  it('clicking a specific version in the timeline opens that version, not the default one', async () => {
    vi.stubGlobal('fetch', stubFetch({
      // 기본(anchor v3) 열람과 명시적으로 다른 응답을 v1(타임라인 클릭 대상)에만 배선 —
      // 버전 번호가 실제로 URL에 실려 구분됐는지 검증하는 게 이 테스트의 핵심.
      versionDetailByArtifact: {
        'a1:1': versionDetail('a1', 1, [{ id: 'n2', type: 'html_blob', props: { html: '<div>버전1 콘텐츠</div>' } }]),
        'a1:3': versionDetail('a1', 3, [{ id: 'n1', type: 'html_blob', props: { html: '<div>기본(앵커) 콘텐츠</div>' } }]),
      },
    }));
    await mount();
    const row = container.querySelector('[role="button"]');
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const versionBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('v1'));
    expect(versionBtn).toBeDefined();
    await act(async () => { versionBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const dialogIframe = findDialogIframe();
    expect(dialogIframe).not.toBeUndefined();
    expect(dialogIframe!.srcdoc).toContain('버전1 콘텐츠');
    expect(dialogIframe!.srcdoc).not.toContain('기본(앵커) 콘텐츠');
  });

  it('thumbnail prefers a PNG export over live content when one exists (no live iframe rendered)', async () => {
    vi.stubGlobal('fetch', stubFetch({
      exportsByArtifact: { a1: [{ id: 'exp1', artifact_id: 'a1', version_id: 'v1', version_number: 3, format: 'png', created_by: 'm1', created_at: '', asset_id: 'asset1', download_url: 'https://cdn.example.com/a1.png' }] },
      versionDetailByArtifact: { a1: versionDetail('a1', 3) },
    }));
    await mount();
    const thumb = container.querySelector('[data-artifact-thumbnail]');
    expect(thumb?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/a1.png');
    expect(thumb?.querySelector('iframe')).toBeNull();
  });

  it('shows a neutral format placeholder — never a fake "preparing" state — when nothing is renderable', async () => {
    vi.stubGlobal('fetch', stubFetch()); // no exports, no version detail configured → both miss
    await mount();
    const thumb = container.querySelector('[data-artifact-thumbnail]');
    expect(thumb?.querySelector('img')).toBeNull();
    expect(thumb?.querySelector('iframe')).toBeNull();
    expect(thumb?.textContent).not.toMatch(/준비 중|불러오는 중/);
  });
});
