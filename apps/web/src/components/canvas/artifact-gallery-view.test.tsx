// @vitest-environment jsdom
//
// story a15cea4f — 산출물 갤러리 회귀가드. fetch를 4축 lookup + artifacts로 스텁해 실 렌더를
// 검증(mock 컴포넌트 없음, projectId는 story a539c649 S3a부터 prop으로 고정 주입).
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

function versionDetail(
  artifactId: string, versionNumber: number, nodes: unknown[] = [HTML_NODE],
  canvasBounds: { w: number; h: number } | null = null,
) {
  return {
    id: artifactId, title: '웰컴 이메일 시안', story_id: null, epic_id: 'e1', doc_id: null,
    source: 'created', latest_version_number: 3, anchor_version: 3, created_by: 'm1',
    created_at: '2026-07-01T00:00:00Z', version_number: versionNumber, version_summary: null, nodes,
    canvas_bounds: canvasBounds,
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
      return jsonRes([
        { id: 'v1', version_number: 1, summary: '초안 레이아웃', created_by: 'm1', created_at: '', source_comment_id: null },
        { id: 'v3', version_number: 3, summary: '최종본', created_by: 'm1', created_at: '', source_comment_id: null },
      ]);
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
        <ArtifactGalleryView projectId="proj-1" />
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

  it('story 6d0a0e3a — GROUP BY(axis segment + group list) is integrated into the same left rail container, not split into a header-top tab row (목업 0d852d24 배치 SSOT)', async () => {
    await mount();
    // 둘 다 같은 좌 레일 컨테이너 안에 있다(desktop lg:block 사본 기준) — 서로 다른 컨테이너로
    // 쪼개져 있던 #2124 이래의 배치 오류(우측 상단 탭)가 아니다.
    const desktopRail = container.querySelector('.hidden.h-fit.lg\\:block');
    expect(desktopRail).not.toBeNull();
    const epicBtn = [...(desktopRail?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '에픽');
    const groupBtn = [...(desktopRail?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('온보딩 캠페인'));
    expect(epicBtn).toBeDefined();
    expect(groupBtn).toBeDefined();
  });

  it('story 6d0a0e3a — provides a native collapsible top selector for narrow viewports (details/summary), in addition to the always-visible desktop rail', async () => {
    await mount();
    const details = container.querySelector('details.lg\\:hidden');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')).not.toBeNull();
    // 접이식 셀렉터 안에도 동일한 축 세그먼트+그룹 목록이 있다(데스크톱 사본과 동일 내용).
    const collapsibleEpicBtn = [...(details?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '에픽');
    expect(collapsibleEpicBtn).toBeDefined();
  });

  it('story 39313b40 — renders artifacts as a responsive multi-column card grid, not a row list (doc §3, no row/grid toggle in v1)', async () => {
    await mount();
    const grid = container.querySelector('.grid.grid-cols-\\[repeat\\(auto-fill\\,minmax\\(220px\\,1fr\\)\\)\\]');
    expect(grid).not.toBeNull();
    expect(grid?.children.length).toBeGreaterThan(0);
    // 행 리스트(3d888ba2) 잔재가 남아있지 않다 — role="button" 행+펼침 토글은 폐지됐다.
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it('opening the card modal lazily fetches and renders the version tabs inside it (story 39313b40 — 그리드 인라인 펼침 폐지, 감시금지: 작성자/횟수/경과시간 0)', async () => {
    vi.stubGlobal('fetch', stubFetch({ versionDetailByArtifact: { a1: versionDetail('a1', 3) } }));
    await mount();
    const cardBtn = container.querySelector('[title="산출물 열기"]') as HTMLButtonElement;
    expect(cardBtn).not.toBeNull();
    await act(async () => { cardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // 버전 탭은 base-ui Dialog 포탈이라 document.body에서 확인(container 밖).
    expect(document.body.textContent).toContain('초안 레이아웃');
    expect(document.body.textContent).not.toContain('m1');
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

  it('clicking a specific version tab inside the modal opens that version, not the default one (story 39313b40 — 모달 내 버전 탭)', async () => {
    vi.stubGlobal('fetch', stubFetch({
      // 기본(anchor v3) 열람과 명시적으로 다른 응답을 v1(탭 클릭 대상)에만 배선 —
      // 버전 번호가 실제로 URL에 실려 구분됐는지 검증하는 게 이 테스트의 핵심.
      versionDetailByArtifact: {
        'a1:1': versionDetail('a1', 1, [{ id: 'n2', type: 'html_blob', props: { html: '<div>버전1 콘텐츠</div>' } }]),
        'a1:3': versionDetail('a1', 3, [{ id: 'n1', type: 'html_blob', props: { html: '<div>기본(앵커) 콘텐츠</div>' } }]),
      },
    }));
    await mount();
    const cardBtn = container.querySelector('[title="산출물 열기"]') as HTMLButtonElement;
    await act(async () => { cardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // 버전 탭은 base-ui Dialog 포탈이라 document.body에서 찾는다(container 밖).
    const versionBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('v1'));
    expect(versionBtn).toBeDefined();
    await act(async () => { versionBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const dialogIframe = findDialogIframe();
    expect(dialogIframe).not.toBeUndefined();
    expect(dialogIframe!.srcdoc).toContain('버전1 콘텐츠');
    expect(dialogIframe!.srcdoc).not.toContain('기본(앵커) 콘텐츠');
  });

  it('story 39313b40 — live thumbnail sizes its iframe to the artifact\'s real canvas_bounds, not an arbitrary fixed aspect ratio', async () => {
    vi.stubGlobal('fetch', stubFetch({
      versionDetailByArtifact: { a1: versionDetail('a1', 3, [HTML_NODE], { w: 1920, h: 1080 }) },
    }));
    await mount();
    const thumb = container.querySelector('[data-artifact-thumbnail]');
    const iframe = thumb?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.style.width).toBe('1920px');
    expect(iframe?.style.height).toBe('1080px');
  });

  it('live thumbnail falls back to the same DEFAULT_BOUNDS as the viewer when canvas_bounds is unset (no-fiction — declared fallback, not a guess)', async () => {
    vi.stubGlobal('fetch', stubFetch({
      versionDetailByArtifact: { a1: versionDetail('a1', 3) }, // canvas_bounds: null
    }));
    await mount();
    const thumb = container.querySelector('[data-artifact-thumbnail]');
    const iframe = thumb?.querySelector('iframe');
    expect(iframe?.style.width).toBe('1280px');
    expect(iframe?.style.height).toBe('800px');
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

describe('ArtifactGalleryView 빈상태 — 그리기|임포트 co-located 진입점(story 64010b05)', () => {
  it('shows both entry points, and "임포트" routes the shared story picker to the import dialog', async () => {
    vi.stubGlobal('fetch', stubFetch({ artifacts: [], stories: [{ id: 's1', title: '온보딩 개선' }] }));
    await mount();

    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['산출물 그리기', '임포트']);

    const importButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '임포트')!;
    await act(async () => { importButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 피커(base-ui Dialog, document.body 포탈)가 뜬다 — 스토리 선택 전까진 임포트 다이얼로그 아님.
    expect(document.body.textContent).toContain('스토리 선택');
    // StoryPickerDialog는 250ms 디바운스 후 검색 결과를 렌더한다(실 타이머) — 그만큼 대기.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    const storyButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '온보딩 개선')!;
    await act(async () => { storyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 스토리 선택 후 — "그리기"였다면 ArtifactEditor(버전으로 저장)가 떴겠지만, intent=import라
    // ImportArtifactDialog(산출물 임포트)가 대신 뜬다.
    expect(document.body.textContent).toContain('산출물 임포트');
    expect(document.body.textContent).not.toContain('버전으로 저장');
  });

  it('"산출물 그리기" still routes to the create flow (기존 083176e8 경로 회귀 0)', async () => {
    vi.stubGlobal('fetch', stubFetch({ artifacts: [], stories: [{ id: 's1', title: '온보딩 개선' }] }));
    await mount();

    const createButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '산출물 그리기')!;
    await act(async () => { createButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    const storyButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '온보딩 개선')!;
    await act(async () => { storyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('버전으로 저장');
    expect(document.body.textContent).not.toContain('산출물 임포트');
  });
});
