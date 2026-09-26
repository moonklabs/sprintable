// @vitest-environment jsdom
//
// story #2713 — standalone 아티팩트 상세 진입점 회귀가드. storyId 없이 단건 fetch만으로
// ArtifactViewer가 뜨는지(양성)와, 존재하지 않는/접근 불가 id면 not-found 상태로 빠지는지
// (음성) 둘 다 확認 — ArtifactSection의 story-scoped 로더를 재사용하는 것이라 로더 자체의
// 정상/에러 분기 로직은 artifact-section.test.tsx가 이미 커버, 여기선 "storyId 없이도
// 뜬다"는 이 컴포넌트 고유의 결합만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactDetailView } from './artifact-detail-view';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(artifactId: string, projectId?: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactDetailView artifactId={artifactId} projectId={projectId} />
      </NextIntlClientProvider>,
    );
  });
  // detail → (comments·versions·pins·gates) 순차 fetch 체인 플러시.
  await act(async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
  });
}

function stubFetch(detailOk: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/pins')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    // story #2721(별건, 이번 판 사이 develop에 머지) — ArtifactViewer가 이제 EntityBacklinksSection도
    // 그려 `/backlinks`를 fetch한다. `/comments`보다 먼저 걸러야 한다(문자열 포함 검사라 순서 무관하지만
    // 명시적으로 분리 — items 배열 형상 계약이 detail 폴백과 달라 섞이면 items.filter 크래시).
    if (url.includes('/backlinks')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/versions')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
    // 단건 상세 — storyId/epic_id/doc_id 전부 null(standalone, 이 스토리의 핵심 실증 대상).
    if (!detailOk) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({
        data: {
          id: 'artifact-1', title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
          source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
          created_at: '2026-08-17T00:00:00Z', version_number: 1, version_summary: null, nodes: [],
        },
      }),
    };
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
}

describe('ArtifactDetailView — standalone 상세(story #2713)', () => {
  it('storyId 없이 artifactId만으로 ArtifactViewer가 뜬다(양성)', async () => {
    stubFetch(true);
    await mount('artifact-1');
    expect(container.textContent).toContain('흐름판 재설계 시안');
    expect(container.textContent).toContain('갤러리로 돌아가기');
  });

  it('404(미존재/접근 불가)면 not-found 상태로 빠진다 — existence-non-disclosure 그대로 상속', async () => {
    stubFetch(false);
    await mount('artifact-missing');
    expect(container.textContent).toContain('산출물을 찾을 수 없어요');
    expect(container.textContent).not.toContain('갤러리로 돌아가기');
  });
});

describe('ArtifactDetailView — 새 좌표 코멘트 생성(story #2725, standalone 표면)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON() { return {}; },
    } as DOMRect);
  });
  afterEach(() => { rectSpy.mockRestore(); });

  it('picking a coordinate and submitting POSTs anchor_x/anchor_y (no parent_id) — storyId 없는 표면에서도 도달성 성립', async () => {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pins')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/backlinks')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/comments') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return { ok: true, status: 201, json: async () => ({ data: {} }) };
      }
      if (url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/versions')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            id: 'artifact-1', title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
            source: 'created', latest_version_number: 1, anchor_version: null, created_by: null,
            created_at: '2026-08-17T00:00:00Z', version_number: 1, version_summary: null, nodes: [],
          },
        }),
      };
    }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);

    await mount('artifact-1');

    const toggle = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    await act(async () => {
      viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 128, clientY: 80, button: 0 }));
      viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 128, clientY: 80 }));
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '여기 확인 부탁');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '코멘트')!;
    await act(async () => { submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(posted).toHaveLength(1);
    const body = posted[0] as { content: string; anchor_x: number; anchor_y: number; parent_id?: string };
    expect(body.content).toBe('여기 확인 부탁');
    expect(body.anchor_x).toBeCloseTo(10, 5); // 128/1280*100
    expect(body.anchor_y).toBeCloseTo(10, 5); // 80/800*100
    expect(body.parent_id).toBeUndefined();
  });
});

// story #4343 — «버전 계보» 레일이 버전이 몇 개든 늘 한 줄(현재)만 보였다: 상세 응답은 현재 버전 하나뿐이고(`adaptArtifactDetail` → [version]),
// 같은 화면이 이미 받는 버전 목록(`GET /{id}/versions`)은 코멘트에만 썼다(dev 60e7e6cf 실측: 목록 8 · 레일 1).
// 이제 레일 줄 = 목록 수 · 현재/기준/선택 표시 · 이전 버전을 고르면 그 버전 실물(`GET /{id}/versions/{n}`)이 뷰어에 뜬다.
// `versions: [version]`로 되돌리면(목록 안 합침) 레일이 한 줄이 되어 RED.
describe('ArtifactDetailView — 버전 계보 레일 = 버전 목록 전부(story #4343)', () => {
  const detailOf = (n: number, html: string, id = 'artifact-1') => ({
    id, title: '흐름판 재설계 시안', story_id: null, epic_id: null, doc_id: null,
    source: 'created', latest_version_number: 3, anchor_version: 1, created_by: null,
    created_at: `2026-09-0${n}T00:00:00Z`, version_number: n, version_summary: `판 ${n}`,
    nodes: [{ id: `n${n}`, type: 'html_blob', parent_id: null, order: 0, props: { html }, description: null }],
  });
  const summaries = [3, 2, 1].map((n) => ({ id: `row-${n}`, version_number: n, summary: `판 ${n}`, created_by: null, created_at: `2026-09-0${n}T00:00:00Z`, source_comment_id: null }));
  let versionDetailCalls: number[];
  let versionDetailIds: string[];
  let heldVersion: (() => void) | null;

  // 본문에 산출물 id를 싣는다(`artifact-1 v2 본문`) — 산출물이 바뀌었는데 옛 산출물의 버전이 보이면 잡히게.
  // `hold`: 그 번호의 버전 실물 응답을 `heldVersion()`이 부를 때까지 붙잡는다(받는 중 상태를 실제로 본다).
  let memberCalls: string[];
  function stubVersions({ failVersion, failOnce, hold, members, authors }: { failVersion?: number; failOnce?: number; hold?: number; members?: { id: string; name: string | null }[]; authors?: Record<number, string> } = {}) {
    versionDetailCalls = [];
    memberCalls = [];
    versionDetailIds = [];
    heldVersion = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pins') || url.includes('/backlinks') || url.includes('/comments')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (url.includes('/api/gates')) return { ok: true, status: 200, json: async () => [] };
      if (url.startsWith('/api/members')) { memberCalls.push(url); return { ok: true, status: 200, json: async () => ({ data: members ?? [] }) }; }
      if (url.startsWith('/api/team-members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      const id = /\/visual-artifacts\/([^/?]+)/.exec(url)?.[1] ?? 'artifact-1';
      const one = /\/versions\/(\d+)$/.exec(url);
      if (one) {
        const n = Number(one[1]);
        versionDetailCalls.push(n);
        versionDetailIds.push(id);
        if (n === hold) await new Promise<void>((resolve) => { heldVersion = resolve; });
        if (n === failVersion) return { ok: false, status: 404, json: async () => ({}) };
        if (n === failOnce && versionDetailCalls.filter((x) => x === n).length === 1) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: detailOf(n, `<p>${id} v${n} 본문</p>`, id) }) };
      }
      if (url.endsWith('/versions')) return { ok: true, status: 200, json: async () => ({ data: summaries.map((sm) => ({ ...sm, created_by: authors?.[sm.version_number] ?? sm.created_by })) }) };
      return { ok: true, status: 200, json: async () => ({ data: { ...detailOf(3, `<p>${id} v3 본문</p>`, id), created_by: authors?.[3] ?? null } }) };
    }) as unknown as ReturnType<typeof vi.fn>);
  }
  const rail = () => [...container.querySelectorAll('p')].find((p) => p.textContent === (koMessages.canvas as LooseMessages).versionLineage)!.parentElement!;
  const rows = () => [...rail().querySelectorAll('li > button')] as HTMLButtonElement[];
  const rowOf = (n: number) => rows().find((b) => (b.textContent ?? '').includes(`v${n}`))!;
  const stageHtml = () => container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
  const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

  it('버전 셋 → 레일 셋 줄 · 고르개 셋 · 현재(v3) · 기준(v1 — 이전 버전이어도) 표시', async () => {
    stubVersions();
    await mount('artifact-1');
    expect(rows()).toHaveLength(3);
    expect(rows().map((b) => /v(\d)/.exec(b.textContent ?? '')?.[1])).toEqual(['3', '2', '1']);
    expect(rowOf(3).textContent).toContain((koMessages.canvas as LooseMessages).versionCurrentTag as string);
    expect(rowOf(1).textContent).toContain((koMessages.canvas as LooseMessages).versionAnchorTag as string);
    expect([...container.querySelectorAll('select option')].map((o) => o.textContent)).toEqual(['v3', 'v2', 'v1']);
    expect(stageHtml()).toContain('v3 본문');
    expect(versionDetailCalls).toEqual([]);
  });

  it('레일에서 v1을 고르면 그 버전 실물을 한 번 받아 뷰어에 — 다시 v3 · v1로 오가도 더 안 받음', async () => {
    stubVersions();
    await mount('artifact-1');
    await act(async () => { rowOf(1).click(); });
    await flush();
    expect(versionDetailCalls).toEqual([1]);
    expect(stageHtml()).toContain('v1 본문');
    expect(rowOf(1).className).toContain('bg-muted/60');
    await act(async () => { rowOf(3).click(); });
    expect(stageHtml()).toContain('v3 본문');
    await act(async () => { rowOf(1).click(); });
    await flush();
    expect(versionDetailCalls).toEqual([1]);
    expect(stageHtml()).toContain('v1 본문');
  });

  it('고르개(select)로 골라도 같다', async () => {
    stubVersions();
    await mount('artifact-1');
    const select = container.querySelector('select')!;
    await act(async () => { select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(versionDetailCalls).toEqual([2]);
    expect(stageHtml()).toContain('v2 본문');
  });

  // 유나(4723) — 이 화면만 memberMap을 안 넘겨 판 줄 작성자가 전부 «알 수 없는 구성원»이었다 → 프로젝트 범위 이름표(스토리 패널과 같은 원천).
  it('판 줄 작성자 = 프로젝트 구성원 이름 · 같은 이름 둘은 4311 꼬리(id 앞 8자) · 프로젝트 id로 한 번 받음', async () => {
    stubVersions({
      members: [{ id: 'e75ca548-1', name: '송윤재' }, { id: '2fd14616-2', name: '송윤재' }, { id: 'm-anna', name: '안나' }],
      authors: { 3: 'e75ca548-1', 2: '2fd14616-2', 1: 'm-anna' },
    });
    await mount('artifact-1', 'p-1');
    const unknown = (koMessages.common as LooseMessages).memberUnknown as string;
    const author = (n: number) => [...rowOf(n).querySelectorAll('[data-row-name-part]')].map((e) => e.textContent).join('');
    expect(author(3)).toBe('송윤재 · e75ca548');
    expect(author(2)).toBe('송윤재 · 2fd14616');
    expect(author(1)).toBe('안나');
    expect(rail().textContent).not.toContain(unknown);
    expect(memberCalls).toEqual(['/api/members?project_id=p-1']);
  });

  it('프로젝트 id가 없으면 구성원 GET 0(옛 호출부 무변)', async () => {
    stubVersions();
    await mount('artifact-1');
    expect(memberCalls).toEqual([]);
    expect(rows()).toHaveLength(3);
  });

  // 까디르(4723) — 예전 테스트는 곧바로 풀리는 fetch라 받는 중 상태를 한 번도 안 봤다 → 응답을 붙잡고 본다.
  it('받는 중 — 응답 전엔 «불러오는 중…»(role=status) · 캔버스 0 · 응답 뒤 그 버전 본문', async () => {
    stubVersions({ hold: 2 });
    await mount('artifact-1');
    await act(async () => { rowOf(2).click(); });
    await flush();
    expect(versionDetailCalls).toEqual([2]);
    const loading = container.querySelector('[data-version-loading="loading"] p');
    expect(loading?.textContent).toBe((koMessages.common as LooseMessages).loading);
    expect(loading?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-version-loading] button')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    await act(async () => { heldVersion!(); });
    await flush();
    expect(container.querySelector('[data-version-loading]')).toBeNull();
    expect(stageHtml()).toContain('artifact-1 v2 본문');
  });

  // 까디르(4723) — 받은 버전 캐시는 버전 번호로만 키라, 같은 뷰어가 다른 산출물을 받으면 옛 산출물의 v2가 그대로 쓰였다 → key={artifact.id}.
  it('산출물이 바뀌면 받아 둔 버전을 버린다 — 같은 번호(v2)도 새 산출물 것을 다시 받음', async () => {
    stubVersions();
    await mount('artifact-1');
    await act(async () => { rowOf(2).click(); });
    await flush();
    expect(stageHtml()).toContain('artifact-1 v2 본문');
    await mount('artifact-2');
    await flush();
    await act(async () => { rowOf(2).click(); });
    await flush();
    expect(versionDetailIds).toEqual(['artifact-1', 'artifact-2']);
    expect(stageHtml()).toContain('artifact-2 v2 본문');
    expect(stageHtml()).not.toContain('artifact-1');
  });

  it('받는 중엔 «불러오는 중…» · 못 받으면 «이 버전을 불러오지 못했어요.»(빈 캔버스로 «비었다»는 거짓 0)', async () => {
    stubVersions({ failVersion: 2 });
    await mount('artifact-1');
    await act(async () => { rowOf(2).click(); });
    await flush();
    expect(versionDetailCalls).toEqual([2]);
    expect(container.querySelector('[data-version-loading="failed"] p')?.textContent).toBe((koMessages.canvas as LooseMessages).versionLoadFailed);
    expect(container.querySelector('iframe')).toBeNull();
  });

  // 유나(4723) — 한 번 실패한 버전이 다시 안 불려 늘 «못 했어요»였다 → «다시 시도»로 그 버전만 다시 부른다.
  it('실패 → «다시 시도» → 그 버전만 다시 받아 뷰어에(다른 버전 요청 0)', async () => {
    stubVersions({ failOnce: 2 });
    await mount('artifact-1');
    await act(async () => { rowOf(2).click(); });
    await flush();
    expect(versionDetailCalls).toEqual([2]);
    const retry = [...container.querySelectorAll('[data-version-loading="failed"] button')].find((b) => b.textContent === (koMessages.common as LooseMessages).retry) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    await flush();
    expect(versionDetailCalls).toEqual([2, 2]);
    expect(stageHtml()).toContain('v2 본문');
    expect(container.querySelector('[data-version-loading]')).toBeNull();
  });
});
