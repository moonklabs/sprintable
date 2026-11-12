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
import { LAYER } from '@/components/ds/layers';
import koMessagesRaw from '../../../messages/ko.json';

// 4910 — 위 막대 제목 칸(TopBarSlot)은 위 막대 문맥이 있어야 서니, 그 자리에 제목을 그대로 그리는 대역으로 바꿔 «제목은 위 막대에만»을 잰다. 나머지(ds · 갤러리 · 썸네일 · 다이얼로그)는 실물.
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/artifacts',
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title }: { title?: React.ReactNode }) => <div data-testid="top-bar-slot-stub">{title}</div>,
}));

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
    if (url.startsWith('/api/goals')) return jsonRes([{ id: 'e1', title: '온보딩 캠페인' }]);
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
    // 이유는 title 한 줄이 아니라 읽는 곳(aria-describedby → 화면 읽기용 글)에 선다 — verify:no-title-only-disabled-reason.
    const noteId = featureBtn?.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toBe('기능별 모아보기는 아직 지원하지 않아요');
  });

  it('shows the anchor pill only for artifacts that actually have an anchor version (no fabricated anchors)', async () => {
    await mount();
    expect(container.textContent).toContain('정본 v3');
  });

  // story #2724(2026-08-17) — 카드 레벨 미연결 배지. 기본 픽스처(ARTIFACTS)는 둘 다
  // story_id/doc_id 없음(양성) — 별도 story_id 세팅 픽스처로 음성도 같이 확認.
  it('story #2724 — shows the unlinked badge on cards without story_id/doc_id', async () => {
    await mount();
    expect(container.textContent).toContain('미연결');
  });

  it('story #2724 — hides the unlinked badge once the artifact has a story_id', async () => {
    vi.stubGlobal('fetch', stubFetch({
      artifacts: [
        { id: 'a1', title: '웰컴 이메일 시안', story_id: 's1', epic_id: 'e1', doc_id: null, source: 'created', latest_version_number: 3, anchor_version: 3, created_by: 'm1', created_at: '2026-07-01T00:00:00Z' },
      ],
      stories: [{ id: 's1', title: '웰컴 이메일', sprint_id: null, epic_id: 'e1' }],
    }));
    await mount();
    expect(container.textContent).not.toContain('미연결');
  });

  it('4910 — «묶어서 보기» is ONE filter row (axis buttons with aria-pressed + a group select); the old left rail and the narrow <details> are gone', async () => {
    await mount();
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('.lg\\:block')).toBeNull();
    const filters = container.querySelector('[data-testid="artifact-gallery-filters"]')!;
    expect(filters).not.toBeNull();
    const axisButtons = [...filters.querySelectorAll('[role="group"] button')];
    expect(axisButtons.map((b) => b.textContent)).toEqual(['목표', '스토리', '스프린트', '문서', '기능']);
    expect(axisButtons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(axisButtons[1]!.getAttribute('aria-pressed')).toBe('false');
    const select = filters.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(document.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('그룹');
    expect([...select.options].map((o) => o.textContent)).toEqual(['온보딩 캠페인 · 1개', '무소속 · 1개']);
  });

  it('4910 — picking another group in the select shows that group\'s cards only', async () => {
    await mount();
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(container.querySelectorAll('[data-testid="artifact-card"]').length).toBe(1);
    expect(container.textContent).toContain('웰컴 이메일 시안');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(select, select.options[1]!.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="artifact-card"]').length).toBe(1);
    expect(container.textContent).toContain('배너 세트 A');
    expect(container.textContent).not.toContain('웰컴 이메일 시안');
  });

  it('4910 — the title lives only in the top bar slot; the body has no heading of its own', async () => {
    await mount();
    const stub = container.querySelector('[data-testid="top-bar-slot-stub"]')!;
    expect(stub.textContent).toBe('산출물');
    expect(container.querySelectorAll('h1').length).toBe(1); // 위 막대 대역 안의 것 하나뿐
    expect(stub.querySelector('h1')).not.toBeNull();
    // 머리 칸에는 설명 + 개수가 서고 제목 글은 다시 서지 않는다.
    const page = container.querySelector('[data-testid="artifact-gallery"]')!;
    expect(page.textContent).toContain('2개');
  });

  it('4910 — «산출물 그리기 · 임포트» stand in the head even when artifacts exist (they used to exist only in the empty state)', async () => {
    await mount();
    expect(container.querySelectorAll('[data-testid="artifact-card"]').length).toBeGreaterThan(0);
    const head = [...container.querySelectorAll('button')].filter((b) => b.textContent === '산출물 그리기' || b.textContent === '임포트');
    expect(head.map((b) => b.textContent)).toEqual(['산출물 그리기', '임포트']);
  });

  it('4910 — layer faces: the panel is LAYER.panel, a card is LAYER.rowOthers, its thumbnail well is LAYER.well (the three differ — styles/layer-rule.test.ts measures the steps)', async () => {
    await mount();
    const panel = container.querySelector('[data-testid="artifact-gallery-panel"]')!;
    for (const cls of LAYER.panel.split(' ')) expect(panel.classList.contains(cls)).toBe(true);
    const card = container.querySelector('[data-testid="artifact-card"]')!;
    for (const cls of LAYER.rowOthers.split(' ')) expect(card.classList.contains(cls)).toBe(true);
    const well = card.firstElementChild!;
    for (const cls of LAYER.well.split(' ')) expect(well.classList.contains(cls)).toBe(true);
    expect(well.querySelector('[data-artifact-thumbnail]')).not.toBeNull();
  });

  it('4910 — right-click on a card opens a menu with ONLY the two existing actions (산출물 열기 · 상세 페이지로); the second goes to the detail route', async () => {
    pushMock.mockClear();
    vi.stubGlobal('fetch', stubFetch({ versionDetailByArtifact: { a1: versionDetail('a1', 3) } }));
    await mount();
    const card = container.querySelector('[data-testid="artifact-card"]') as HTMLElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 2 })); });
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['산출물 열기', '상세 페이지로']);
    await act(async () => { items[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/artifacts/a1');
  });

  it('4910 — the same two actions stay reachable without a right-click (thumbnail button + title link): no right-click-only action', async () => {
    await mount();
    const card = container.querySelector('[data-testid="artifact-card"]')!;
    expect(card.querySelector('button[title="산출물 열기"]')).not.toBeNull();
    expect(card.querySelector('a[href="/artifacts/a1"]')).not.toBeNull();
  });

  it('4910 — the loading state is a labelled skeleton group, not an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    await mount();
    const sk = container.querySelector('[role="status"][aria-busy="true"]');
    expect(sk).not.toBeNull();
    expect(sk!.getAttribute('aria-label')).toBe('불러오는 중…');
    expect(container.querySelector('[data-testid="artifact-card"]')).toBeNull();
  });

  it('story 39313b40 — renders artifacts as a responsive multi-column card grid, not a row list (doc §3, no row/grid toggle in v1)', async () => {
    await mount();
    // 4910 — 칸 수: 폰 2 · sm 3 · lg 4.
    const grid = container.querySelector('.grid.grid-cols-2.sm\\:grid-cols-3.lg\\:grid-cols-4');
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
    expect(container.textContent).toContain('아직 모인 산출물이 없어요');
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

// story #3378(결함·customer-zero, 선생님 실사용) — 카드가 «크게 보기» 다이얼로그로만
// 이어지고 상세 페이지(내보내기·정본 제안·코멘트·버전)로 갈 길이 없던 결함.
describe('ArtifactGalleryView — 상세 페이지 진입(story #3378)', () => {
  it('the card title is a real link to /artifacts/{id} — a click reaches the detail route in ≤2 clicks from the gallery', async () => {
    await mount();
    const titleLink = container.querySelector('a[href="/artifacts/a1"]');
    expect(titleLink).not.toBeNull();
    expect(titleLink!.textContent).toContain('웰컴 이메일 시안');
  });

  // 유나 design verdict(ad31d9449) — 배지행이 제목 Link 밖에 있으면 카드 하단이 hover:border로
  // «눌린다»는 인상을 주면서 실제로는 아무 데도 안 이어지는 죽은 면적이 된다. 배지도 이제
  // 같은 Link 안에 있어야 한다(제목+메타 전체가 상세로 가는 클릭 가능 영역).
  it('the badge row (anchor/latest chips) sits inside the same detail link — no dead-click area below the title (design verdict)', async () => {
    await mount();
    const titleLink = container.querySelector('a[href="/artifacts/a1"]');
    expect(titleLink?.textContent).toContain('v3까지'); // galleryLatestChip
  });

  it('the expand dialog carries a 「상세 페이지로」 link so it is no longer a dead end', async () => {
    vi.stubGlobal('fetch', stubFetch({
      versionDetailByArtifact: { a1: versionDetail('a1', 3) },
    }));
    await mount();
    const thumbBtn = container.querySelector('[title="산출물 열기"]') as HTMLButtonElement;
    await act(async () => { thumbBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // 카드 제목 링크(container 안)와 다이얼로그 링크(base-ui Portal, container 밖)가 둘 다
    // href="/artifacts/a1"이라 container 밖 것만 골라야 다이얼로그 쪽을 잡는다.
    const detailLink = [...document.body.querySelectorAll('a[href="/artifacts/a1"]')].find((el) => !container.contains(el));
    expect(detailLink).not.toBeUndefined();
    expect(detailLink!.textContent).toBe('상세 페이지로');
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
