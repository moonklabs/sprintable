// @vitest-environment jsdom
//
// story #3368(Phase0·마케팅운영 S4) — 글 편집(S3). AC2 pin: 저장하면 새 버전 번호와
// "미상신"(초안) 상태가 표시되고, slug·lang은 잠겨(표시만, 입력란 없음) 재전송된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));
// story 15e481ce(#3453 AC1) — 변형 생성 성공 뒤 router.push로 이동한다.
const { routerPushMock } = vi.hoisted(() => ({ routerPushMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
  useRouter: () => ({ push: routerPushMock }),
}));

import ContentPostEditPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const ORG_ID = 'org-1';
const DRAFT_ID = 'd1';

beforeEach(() => {
  // 페드루 PO 리뷰(2026-09-03) — 발행 취소 버튼 role 게이팅 기본값은 'owner'(기존 22개
  // 테스트가 전부 "권한 있음" 전제로 버튼 클릭을 검증해 왔다). member 케이스는 개별
  // 테스트가 이 값을 owner/admin이 아닌 값으로 덮어쓴다.
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'owner' });
  useParamsMock.mockReturnValue({ draftId: DRAFT_ID });
  routerPushMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const VERSION_1 = {
  version_id: 'v1', version: 1, slug: '2ho-blog', source_story_id: 'w1', title: '2호 글',
  lang: 'ko', summary: '요약입니다', tags: ['ai', 'product'], body_md: '# 제목\n\n본문입니다.',
  body_sha256: 'h1', author_member_id: 'agent-1', author_kind: 'agent', created_at: '2026-09-03T03:50:00+00:00',
};

function stubFetchWithVersions(
  versions: unknown[],
  onSave?: (body: unknown) => { status: number; body: unknown },
  onSubmit?: (body: unknown) => { status: number; body: unknown },
  opts?: {
    gates?: unknown[];
    onPublish?: () => { status: number; body: unknown };
    // story #3386 — 기본값은 "발행 안 됨"(전부 null). 개별 테스트가 발행됨 상태를
    // 재현하려면 이 필드를 넘긴다.
    // story #3479(BE #3476/#3828) — destination·channel_publication·command 추가.
    publication?: {
      published_at: string | null; url: string | null; published_by_member_id: string | null; published_body_sha256: string | null;
      destination?: string;
      // story #3499 — BE #3844 조각4(미착지) 의존, optional.
      publication_id?: string | null;
      channel_publication?: {
        status: string; external_id: string | null; permalink: string | null;
        published_at: string | null; unpublished_at: string | null; last_error: string | null;
        publication_id?: string | null;
      } | null;
      command?: {
        id: string; command_status: string; attempt_count: number; failure_kind: string | null;
        next_retry_at: string | null; dead_letter_at: string | null; command_reason_code: string | null; last_error: string | null;
      } | null;
    };
    // story #3499 — /publications/{id}/insights 응답. 넘기지 않으면(대부분 테스트가
    // publication_id 자체가 없어 이 fetch를 아예 안 탄다) 빈 배열.
    insightSnapshots?: unknown[];
    onUnpublish?: () => { status: number; body: unknown };
    onRetryPublicationCommand?: (commandId: string) => { status: number; body: unknown };
    // 페드루 PO 리뷰(2026-09-03) — 발행자 UUID→이름 해소(gates/[id]/page.tsx의
    // memberNames 관례 재사용). 기본값 빈 배열 — 개별 테스트가 필요할 때만 넘긴다(넘기지
    // 않으면 published_by_member_id가 그대로 앞 8자 폴백으로 렌더된다, 그 자체도 유효한
    // graceful-degradation 케이스).
    teamMembers?: { id: string; name: string }[];
    // story 15e481ce(#3453 AC1·AC2) — 활성 연결·이미 만든 변형. 기본값 0건(대부분
    // 테스트가 이 스토리와 무관 — 자리 자체가 안 뜨는 쪽이 기본).
    activeConnections?: { id: string; channel: string; account_label: string | null; status: string }[];
    variants?: unknown[];
    onCreateVariant?: (body: unknown) => { status: number; body: unknown };
    // story 1db41045(#3457) — 기존 campaign 목록·새로 만들기.
    campaigns?: unknown[];
    onCreateCampaign?: (body: unknown) => { status: number; body: unknown };
    // PATCH .../campaign(버전 0·게이트 무접촉 — 유나 정적 판정 뒤 저장 POST에서 전환).
    onPatchCampaign?: (body: unknown) => { status: number; body: unknown };
    // story #3500(BE #3498, 미착지) — 잔량 조회(기본=정책 미설정).
    genBudget?: { limit_minor: number | null; spent_minor: number; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' };
    // story #3514(lint-on-read, BE 신설) — 단건 GET의 violations[]. 기본값 빈 배열
    // (대부분 테스트가 이 스토리와 무관 — "위반 없음"이 기본).
    draftViolations?: unknown[];
    // 유나 Design 변경요청 1(2026-09-05) — 단건 GET 자체가 실패하는 케이스 재현(기본
    // 200). 부수 데이터라 화면은 그대로 서고 violations=[]+안내 한 줄만 뜬다.
    draftStatus?: number;
    // 유나 실측 후속(§16-7 2부, 2026-09-05) — "응답은 왔는데 실패"(draftStatus)와
    // "응답이 안 옴"(연결 끊김·abort, fetchWithAuth 자체가 던짐)은 다른 갈래다. 이
    // 옵션은 후자 — fetch 자체가 reject한다(HTTP 응답 객체 자체가 없다).
    draftReject?: boolean;
  },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // story #3514 — 단건 GET(신설). /versions보다 먼저 걸러야 한다 — 후자가 이
      // URL을 접두사로 포함한다(정확 일치 비교라 순서 자체는 무해하지만, 나란히
      // 둬 두 계약이 별개 왕복임을 코드로도 보이게 한다).
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}`) {
        if (opts?.draftReject) {
          throw new Error('network error');
        }
        if (opts?.draftStatus && opts.draftStatus >= 400) {
          return { ok: false, status: opts.draftStatus, json: async () => ({ detail: 'boom' }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: { draft_id: DRAFT_ID, violations: opts?.draftViolations ?? [] }, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: versions, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/generation-budget`) {
        const budget = opts?.genBudget ?? { limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' as const };
        return { ok: true, status: 200, json: async () => ({ data: budget, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/variants`) {
        return { ok: true, status: 200, json: async () => ({ data: opts?.variants ?? [], error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/campaign` && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts?.onPatchCampaign?.(body) ?? { status: 200, body: { draft_id: DRAFT_ID, campaign_id: body.campaign_id, campaign_name: body.campaign_id ? '9월 캠페인' : null } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/campaigns` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts?.onCreateCampaign?.(body) ?? { status: 201, body: { id: 'c1', name: body.name, starts_at: null, ends_at: null, status: 'active', created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/campaigns`) {
        return { ok: true, status: 200, json: async () => ({ data: opts?.campaigns ?? [], error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        return { ok: true, status: 200, json: async () => ({ data: opts?.activeConnections ?? [], error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts?.onCreateVariant?.(body) ?? { status: 201, body: { draft_id: 'cp-1', version_id: 'cpv-1', version: 1 } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const result = onSave?.(body) ?? { status: 201, body: { draft_id: DRAFT_ID, version_id: 'v2', version: 2 } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/submit` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = onSubmit?.(body) ?? { status: 404, body: { detail: 'Not Found' } };
        const ok = result.status < 400;
        // 실제 BFF: !ok는 백엔드 원문을 그대로 pass-through(래핑 0), ok는 apiSuccess({data}) 래핑.
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url.startsWith('/api/gates?work_item_id=')) {
        // /api/gates는 BFF가 그대로 배열을 pass-through(래핑 없음, doc-gate-section.tsx와
        // 동일 관례).
        return { ok: true, status: 200, json: async () => opts?.gates ?? [] };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publish` && init?.method === 'POST') {
        // S3(story #3369) — draft_id 하나로 서버가 발행한다, body 없음(레거시 endpoint와 달리
        // 화면이 본문을 재조립해 보내지 않는다).
        const result = opts?.onPublish?.() ?? {
          status: 200, body: { url: 'https://sprintable.ai/ko/blog/2ho-blog', published_at: '2026-09-05T00:00:00Z', version_id: 'v1' },
        };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publication`) {
        // story #3386 — 기본은 "발행 안 됨"(전부 null), 개별 테스트가 opts.publication으로
        // 덮는다. story #3479 — destination 기본 hosted_site·channel_publication/command
        // 기본 null(회귀 0 — 옛 4필드만 넘기는 기존 테스트 전부가 이 기본값을 그대로 탄다).
        const body = opts?.publication ?? {
          published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        };
        const withExternal = {
          destination: 'hosted_site', channel_publication: null, command: null,
          ...body,
        };
        return { ok: true, status: 200, json: async () => ({ data: withExternal, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/publication-commands/cmd-1/retry` && init?.method === 'POST') {
        const result = opts?.onRetryPublicationCommand?.('cmd-1') ?? { status: 200, body: { id: 'cmd-1', status: 'pending' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/unpublish` && init?.method === 'POST') {
        const result = opts?.onUnpublish?.() ?? { status: 200, body: { id: 'p1', slug: '2ho-blog', unpublished_at: '2026-09-05T01:00:00Z' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === '/api/team-members') {
        return { ok: true, status: 200, json: async () => ({ data: opts?.teamMembers ?? [], error: null, meta: null }) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/publications/`) && url.endsWith('/insights')) {
        return { ok: true, status: 200, json: async () => ({ data: opts?.insightSnapshots ?? [], error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

describe('ContentPostEditPage (story #3368 S3)', () => {
  it('⭐AC2 — 최신 버전 필드가 폼에 채워진다', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const titleInput = container.querySelector<HTMLInputElement>('#post-title');
    expect(titleInput?.value).toBe('2호 글');
    expect(container.textContent).toContain('v1');
    expect(container.textContent).toContain(koMessages.content.authorAgent);
  });

  // 유나 라이브 검수(2026-09-03, head 6f575809b) — 편집 화면엔 최종 수정 주체만 있고
  // 원작성 주체가 없어 "원안이 에이전트였다"가 편집 중 안 보였다.
  it('⭐원작성 주체(versions[0])와 최종 수정 주체(latest)가 각각 뜬다(에이전트 원안 → 휴먼 개정)', async () => {
    stubFetchWithVersions([
      VERSION_1,
      { ...VERSION_1, version_id: 'v2', version: 2, author_kind: 'human', author_member_id: 'human-1' },
    ]);
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.fieldOriginAuthor);
    expect(container.textContent).toContain(koMessages.content.fieldLastEditedBy);
    expect(container.textContent).toContain(koMessages.content.authorAgent);
    expect(container.textContent).toContain(koMessages.content.authorHuman);
  });

  it('slug·lang은 입력란 없이 표시만 된다(잠김)', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    expect(container.querySelector('#post-slug')).toBeNull();
    expect(container.querySelector('#post-lang')).toBeNull();
    expect(container.textContent).toContain('2ho-blog');
  });

  it('⭐AC2 — 저장하면 새 버전 번호가 반영되고 성공 메시지가 뜬다(새로고침 동형 — 버전 목록을 다시 읽음)', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    // 두 번째 fetch(versions 재조회)가 v2를 포함하도록 스텁 교체.
    stubFetchWithVersions([VERSION_1, { ...VERSION_1, version_id: 'v2', version: 2, title: '2호 글(수정)' }]);

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta);
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.editSaved);
    expect(container.textContent).toContain('v2');
  });

  it('저장 요청 body에 slug·work_item_id가 잠긴 값 그대로 실린다(새 초안 분기 방지)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], (body) => {
      capturedBody = body as Record<string, unknown>;
      return { status: 201, body: { draft_id: DRAFT_ID, version_id: 'v2', version: 2 } };
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta);
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(capturedBody?.work_item_id).toBe('w1');
    expect(capturedBody?.slug).toBe('2ho-blog');
    expect(capturedBody?.lang).toBe('ko');
  });

  it('저장 실패(422) — 성공 메시지 대신 서버 코드가 사람 말로 렌더된다(§4-1 — 지어내지 않고 매핑)', async () => {
    stubFetchWithVersions([VERSION_1], () => ({
      status: 422, body: { detail: { code: 'MEDIA_NOT_SUPPORTED_PHASE0', message: 'Phase 0은 미디어 입력을 지원하지 않습니다' } },
    }));
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta);
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain(koMessages.content.editSaved);
    expect(container.textContent).toContain(koMessages.content.errorMediaNotSupported);
    expect(container.textContent).toContain('MEDIA_NOT_SUPPORTED_PHASE0'); // 원문 보존(접힘 <details> 안)
  });

  // story #3385(Phase0 결함, PO 실사용 2026-09-03 2회 재현) — 토스트는 성공인데 칩·안내
  // 박스가 리로드 전까지 이전 상태로 남던 결함. 리로드를 흉내내지 않는다(리로드하면 통과
  // 하는 테스트는 이 결함을 못 잡는다는 게 AC2의 명시 — /api/gates 응답을 호출 순서로
  // 갈아 끼워 "상신 직후, 리로드 없이" 그 자리에서 재조회되는지를 그대로 잰다.
  it('⭐AC1 — 승인 요청 성공 뒤 리로드 없이 칩이 «초안»→«승인 대기»로 바뀐다', async () => {
    let gateCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}`) {
        return { ok: true, status: 200, json: async () => ({ data: { draft_id: DRAFT_ID, violations: [] }, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: [VERSION_1], error: null, meta: null }) };
      }
      if (url.startsWith('/api/gates?work_item_id=')) {
        gateCallCount += 1;
        // 1번째 호출(마운트) = 게이트 없음(초안) · 2번째 호출(상신 직후 재조회) = pending.
        const gates = gateCallCount === 1 ? [] : [{ id: 'gate-42', status: 'pending', reapproval_required: false }];
        return { ok: true, status: 200, json: async () => gates };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/submit` && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ data: { gate_id: 'gate-42' }, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('draft');

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(gateCallCount).toBe(2); // 마운트 1회 + 상신 성공 뒤 재조회 1회 — 리로드가 아니라 이 재조회로 갱신됐음을 고정.
    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('pending');
    expect(container.textContent).toContain(koMessages.content.contentStatusPending);
  });

  // AC 본문 "2회차가 더 나쁘다" — 재상신 뒤에도 안내 박스가 안 지워지면 사람이 같은 행동을
  // 반복하거나 상신이 안 됐다고 믿는다.
  it('⭐AC1 — 재상신 성공 뒤 리로드 없이 «재승인 필요» 안내 박스가 사라지고 칩이 «승인 대기»로 바뀐다', async () => {
    let gateCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}`) {
        return { ok: true, status: 200, json: async () => ({ data: { draft_id: DRAFT_ID, violations: [] }, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: [VERSION_1], error: null, meta: null }) };
      }
      if (url.startsWith('/api/gates?work_item_id=')) {
        gateCallCount += 1;
        const gates = gateCallCount === 1
          ? [{ id: 'gate-42', status: 'pending', reapproval_required: true, sealed_content_sha256: 'h0' }]
          : [{ id: 'gate-42', status: 'pending', reapproval_required: false, sealed_content_sha256: 'h1' }];
        return { ok: true, status: 200, json: async () => gates };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/submit` && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ data: { gate_id: 'gate-42' }, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('reapproval_needed');
    expect(container.textContent).toContain(koMessages.content.reapprovalNeededNotice);

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('pending');
    expect(container.textContent).not.toContain(koMessages.content.reapprovalNeededNotice);
  });

  it('⭐승인 요청 성공 — gate_id로 /gates/{id} 딥링크가 뜬다(AC3)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, () => ({
      status: 200, body: { gate_id: 'gate-42', version_id: 'v1', content_sha256: 'h1', status: 'pending' },
    }));
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.submitSuccess);
    const gateLink = container.querySelector<HTMLAnchorElement>('a[href="/gates/gate-42"]');
    expect(gateLink).not.toBeNull();
  });

  it('승인 요청 — S2 미착지(404)도 다른 에러와 동형으로 "지어낸 성공"으로 안 덮는다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, () => ({ status: 404, body: { detail: 'Not Found' } }));
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain(koMessages.content.submitSuccess);
    expect(container.querySelector('a[href^="/gates/"]')).toBeNull();
  });

  // story f6d14476(AC3) — SITE_POST_GATE_ALREADY_HELD 409는 다른 에러와 다르게 상대 초안의
  // 제목을 별도 조회해 「이 항목은 다른 초안(«제목» · lang)이 승인 절차 중입니다」로 렌더하고
  // 그 초안(/content/{holding_draft_id})으로 가는 링크를 붙인다. stubFetchWithVersions는
  // DRAFT_ID 하나만 알므로(다른 초안 동시 존재는 이 helper의 전제 밖) 이 두 테스트는 전용
  // fetch 스텁을 직접 쓴다.
  it('⭐AC3 — 409 SITE_POST_GATE_ALREADY_HELD는 상대 초안 제목을 채워 문구를 조립하고 그 초안 링크를 보여준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}`) {
          return { ok: true, status: 200, json: async () => ({ data: { draft_id: DRAFT_ID, violations: [] }, error: null, meta: null }) };
        }
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
          return { ok: true, status: 200, json: async () => ({ data: [VERSION_1], error: null, meta: null }) };
        }
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/submit`) {
          return {
            ok: false, status: 409,
            json: async () => ({
              data: null,
              error: {
                code: 'SITE_POST_GATE_ALREADY_HELD',
                message: '이 work item은 다른 초안이 이미 승인 절차 중입니다(holding_draft_id=d-other, lang=en, slug=a-blog-en)',
                holding_draft_id: 'd-other', holding_lang: 'en', holding_slug: 'a-blog-en',
              },
              meta: null,
            }),
          };
        }
        if (url === '/api/organizations/org-1/site-posts/drafts/d-other/versions') {
          return {
            ok: true, status: 200,
            json: async () => ({ data: [{ ...VERSION_1, version_id: 'v-other', title: '2호 글(영문판)' }], error: null, meta: null }),
          };
        }
        if (url.startsWith('/api/gates?work_item_id=')) return { ok: true, status: 200, json: async () => [] };
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publication`) {
          return {
            ok: true, status: 200,
            json: async () => ({ data: { published_at: null, url: null, published_by_member_id: null, published_body_sha256: null }, error: null, meta: null }),
          };
        }
        throw new Error('unexpected fetch: ' + url);
      }),
    );
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain('2호 글(영문판)');
    expect(container.textContent).toContain('en');
    const holdingLink = container.querySelector<HTMLAnchorElement>('a[href="/content/d-other"]');
    expect(holdingLink).not.toBeNull();
  });

  it('AC3 — 상대 초안 제목 조회 실패해도(best-effort) slug 폴백 문구+링크는 그대로 뜬다(지어내지 않되 막지 않는다)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}`) {
          return { ok: true, status: 200, json: async () => ({ data: { draft_id: DRAFT_ID, violations: [] }, error: null, meta: null }) };
        }
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
          return { ok: true, status: 200, json: async () => ({ data: [VERSION_1], error: null, meta: null }) };
        }
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/submit`) {
          return {
            ok: false, status: 409,
            json: async () => ({
              data: null,
              error: {
                code: 'SITE_POST_GATE_ALREADY_HELD', message: '…',
                holding_draft_id: 'd-other', holding_lang: 'en', holding_slug: 'a-blog-en',
              },
              meta: null,
            }),
          };
        }
        if (url === '/api/organizations/org-1/site-posts/drafts/d-other/versions') {
          return { ok: false, status: 404, json: async () => ({ detail: 'not found' }) };
        }
        if (url.startsWith('/api/gates?work_item_id=')) return { ok: true, status: 200, json: async () => [] };
        if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publication`) {
          return {
            ok: true, status: 200,
            json: async () => ({ data: { published_at: null, url: null, published_by_member_id: null, published_body_sha256: null }, error: null, meta: null }),
          };
        }
        throw new Error('unexpected fetch: ' + url);
      }),
    );
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain('a-blog-en'); // slug 폴백(제목 조회 실패)
    const holdingLink = container.querySelector<HTMLAnchorElement>('a[href="/content/d-other"]');
    expect(holdingLink).not.toBeNull();
  });

  // story #3368 §8-1 4단(페드루 지시 2026-09-03, S2 계약 전제로 미리 배선) — 실 게이트
  // 신호가 있을 때 상태·발행 버튼이 정확히 파생되는지.
  it('⭐게이트 status=pending — 상태 칩이 "승인 대기"로 뜨고 발행 버튼은 비활성', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'pending', gate_type: 'external_publish' }],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusPending);
    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(true);
  });

  it('⭐게이트 status=approved + 해시 일치 — 상태 칩 "승인됨", 발행 버튼 활성', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'h1' }],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusApproved);
    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(false);
  });

  it('⭐게이트 status=approved인데 해시 불일치 — 재승인 필요 배너·발행 버튼 비활성(§3-2 핵심)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'stale-hash' }],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusReapprovalNeeded);
    expect(container.textContent).toContain(koMessages.content.reapprovalNeededNotice);
    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain(koMessages.content.publishDisabledReason);
  });

  // story #3368 §3-1-1(유나 실측) — approved인데 봉인 해시가 아예 없는 경우("모른다")는
  // reapproval_needed(§3-2 배너)가 아니라 "승인됨" 상태를 유지하되 발행만 막고, 문구도
  // "본문이 바뀌었다"가 아니라 "확인할 수 없다"여야 한다. 이 회귀가 실제로 있었다.
  it('⭐게이트 status=approved인데 봉인 해시 자체가 없음(SEAL_MISSING) — "승인됨" 유지·재승인 배너 없음·확인불가 문구', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish' }],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusApproved);
    expect(container.textContent).not.toContain(koMessages.content.contentStatusReapprovalNeeded);
    expect(container.textContent).not.toContain(koMessages.content.reapprovalNeededNotice);
    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain(koMessages.content.publishDisabledReasonSealMissing);
    expect(container.textContent).not.toContain(koMessages.content.publishDisabledReason);
  });

  it('⭐발행 성공 — 발행 시각·공개 URL 링크가 뜬다(AC5)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'h1' }],
      onPublish: () => ({ status: 200, body: { url: '/ko/blog/2ho-blog', published_at: '2026-09-05T00:00:00Z', version_id: 'v1' } }),
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    await act(async () => {
      publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const link = container.querySelector<HTMLAnchorElement>('a[href="/ko/blog/2ho-blog"]');
    expect(link).not.toBeNull();
  });

  it('⭐발행 호출은 draft 기반 신규 endpoint로 가고 body를 재조립해 보내지 않는다(레거시 endpoint 회귀 방지)', async () => {
    let publishCallInit: RequestInit | undefined;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'h1' }],
      onPublish: () => ({ status: 200, body: { url: 'https://sprintable.ai/ko/blog/2ho-blog', published_at: '2026-09-05T00:00:00Z', version_id: 'v1' } }),
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publish`) {
        publishCallInit = init;
      }
      return realFetch(input, init);
    }));
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    await act(async () => {
      publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(publishCallInit).toBeDefined();
    expect(publishCallInit?.body).toBeUndefined();
  });

  it('발행 실패(403 — 승인 필요) — 원문이 접힌 상세로 보존되고 성공으로 오인 표시하지 않는다(S10)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'h1' }],
      // 실 backend 에러 봉투(글로벌 예외 핸들러, 2026-09-03 curl 실측) — {data:null, error:{...}}.
      onPublish: () => ({ status: 403, body: { data: null, error: { code: 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED', message: '승인이 필요합니다' }, meta: null } }),
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    await act(async () => {
      publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain(koMessages.content.publishViewLink);
    expect(container.textContent).toContain('승인이 필요합니다');
  });

  it('게이트 없음(초안 상태) — 발행 버튼은 항상 비활성', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { gates: [] });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusDraft);
    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(true);
  });
});

// story #3386(Phase0 결함, S8 — 발행됨·URL·행위자) — 원인 진단이 지목한 그 자리
// (hasPublishedSitePost가 항상 undefined였던 계약 갭)를 GET .../publication으로 채운다.
describe('ContentPostEditPage — story #3386(S8 발행됨·URL·행위자)', () => {
  const APPROVED_GATE = [{ id: 'g1', status: 'approved', gate_type: 'external_publish', sealed_content_sha256: 'h1' }];

  it('⭐발행됨 — 상태 칩 "발행됨"·URL 링크·발행 시각이 보이고 발행 버튼은 기본 잠금(AC1·AC2)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'h1',
      },
      teamMembers: [{ id: 'human-1', name: '윤재' }],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusPublished);
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://sprintable.ai/ko/blog/2ho-blog"]');
    expect(link).not.toBeNull();
    expect(container.textContent).toContain(koMessages.content.publishedInfoAtLabel);
    // story 3436(묶음 5) — 발행 시각이 이 화면 다른 곳(변형 목록 등)과 같은 §11-2
    // 정본 형식(formatScheduledAt)을 쓰는지 pin — 브라우저 toLocaleString() 잔존 방지.
    const expectedTz = resolveDisplayTimezone().tz;
    expect(container.textContent).toContain(formatScheduledAt('2026-09-03T18:44:00Z', expectedTz).display);

    const publishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishCta);
    expect(publishButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain(koMessages.content.publishDisabledReasonAlreadyPublished);

    // 페드루 PO 리뷰(2026-09-03, 유나 design verdict) — 발행자는 UUID가 아니라 이름으로
    // 보여야 한다(AC1). gates/[id]/page.tsx의 memberNames 관례를 재사용해 해소한다.
    expect(container.textContent).toContain('윤재');
    expect(container.textContent).not.toContain('human-1');
  });

  it('발행자 이름 해소 실패(team-members 목록에 없음) — UUID 앞 8자로 graceful 폴백한다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-unknown-999', published_body_sha256: 'h1',
      },
      teamMembers: [],
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain('human-un');
  });

  it('⭐발행됨 + 재승인된 새 버전(라이브 해시≠승인 해시) — 「재발행」 라벨로 버튼이 다시 열린다(AC2)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE, // sealed_content_sha256='h1' — VERSION_1.body_sha256도 'h1'
      publication: {
        // 라이브(published_body_sha256)는 아직 옛 버전('old-hash') — 재승인된 h1과 다르다.
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'old-hash',
      },
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusPublished);
    const republishButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.publishRepublishCta);
    expect(republishButton).not.toBeUndefined();
    expect(republishButton?.hasAttribute('disabled')).toBe(false);
  });

  it('⭐AC6 — publication 조회가 실패하면(네트워크 에러) 「승인됨」으로 단정하지 않고 「—」를 그린다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { gates: APPROVED_GATE, onUnpublish: undefined });
    // publication 엔드포인트만 별도로 실패하게 fetch를 재정의.
    const originalFetch = (globalThis as { fetch: typeof fetch }).fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/publication`) {
        throw new Error('network error');
      }
      return originalFetch(input, init);
    }));
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).not.toContain(koMessages.content.contentStatusApproved);
    expect(container.textContent).not.toContain(koMessages.content.contentStatusPublished);
    expect(container.querySelector('[data-status-chip]')).toBeNull();
  });

  it('⭐발행 취소 — 확인 다이얼로그 승인 뒤 unpublish를 호출하고 publication을 다시 읽는다(AC — #3739 엔드포인트)', async () => {
    let unpublishCalled = false;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'h1',
      },
      onUnpublish: () => {
        unpublishCalled = true;
        return { status: 200, body: { id: 'p1', slug: '2ho-blog', unpublished_at: '2026-09-03T19:00:00Z' } };
      },
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const unpublishTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.unpublishCta);
    expect(unpublishTrigger).not.toBeUndefined();
    await act(async () => {
      unpublishTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // ConfirmDialog는 Portal(base-ui)이라 container 밖(document.body)에 뜬다 — 트리거와
    // 같은 라벨("발행 취소")이라 트리거 자신은 참조로 제외하고 나머지를 확인 버튼으로 잡는다.
    const bodyButtons = [...document.body.querySelectorAll('button')].filter((b) => b !== unpublishTrigger);
    const confirmButton = bodyButtons.find((b) => b.textContent === koMessages.content.unpublishConfirmAction);
    expect(confirmButton).not.toBeUndefined();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    expect(unpublishCalled).toBe(true);
    expect(container.textContent).toContain(koMessages.content.unpublishSuccess);
  });

  it('발행 취소 권한 오류(403) — 사람 말 문구로 뜬다(지어낸 성공 없음)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'h1',
      },
      onUnpublish: () => ({
        status: 403,
        body: { data: null, error: { code: 'SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY', message: '발행 취소는 조직 owner 또는 admin만 가능합니다' }, meta: null },
      }),
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const unpublishTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.unpublishCta);
    await act(async () => {
      unpublishTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const bodyButtons = [...document.body.querySelectorAll('button')].filter((b) => b !== unpublishTrigger);
    const confirmButton = bodyButtons.find((b) => b.textContent === koMessages.content.unpublishConfirmAction);
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.errorUnpublishOwnerOrAdminOnly);
    expect(container.textContent).not.toContain(koMessages.content.unpublishSuccess);
  });

  it('AC3 — 재승인 필요(reapproval_needed) 상태여도 이미 공개 중이면 URL·발행 취소 버튼은 그대로 보인다', async () => {
    stubFetchWithVersions(
      [VERSION_1, { ...VERSION_1, version_id: 'v2', version: 2, body_sha256: 'h2' }],
      undefined, undefined,
      {
        gates: [{ id: 'g1', status: 'pending', gate_type: 'external_publish', reapproval_required: true, sealed_content_sha256: 'h1' }],
        publication: {
          published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
          published_by_member_id: 'human-1', published_body_sha256: 'h1',
        },
      },
    );
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain(koMessages.content.contentStatusReapprovalNeeded);
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://sprintable.ai/ko/blog/2ho-blog"]');
    expect(link).not.toBeNull();
    const unpublishTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.unpublishCta);
    expect(unpublishTrigger).not.toBeUndefined();
  });

  // 페드루 PO 리뷰(2026-09-03) — [82d79b81] AC "owner/admin만 활성 · member는 비활성 +
  // 이유 문구(버튼 밖)". role은 useDashboardContext().role(settings/page.tsx·org-members-
  // section.tsx와 같은 소스)에서 온다 — 새 조회 없음.
  it('발행 취소 role 게이팅 — member는 버튼이 비활성이고 버튼 밖에 이유 문구가 보인다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'member' });
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'h1',
      },
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const unpublishTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.unpublishCta);
    expect(unpublishTrigger).not.toBeUndefined();
    expect(unpublishTrigger?.hasAttribute('disabled')).toBe(true);
    // 이유 문구는 버튼 자체의 텍스트가 아니라 버튼 밖 별도 엘리먼트(AC 문구 그대로).
    expect(unpublishTrigger?.textContent).toBe(koMessages.content.unpublishCta);
    expect(container.textContent).toContain(koMessages.content.unpublishDisabledReason);
  });

  it('발행 취소 role 게이팅 — admin은 owner와 동형으로 버튼이 활성이고 이유 문구가 없다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'admin' });
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      gates: APPROVED_GATE,
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: 'human-1', published_body_sha256: 'h1',
      },
    });
    await act(async () => {
      root.render(wrap(<ContentPostEditPage />));
    });
    await flush();
    await flush();

    const unpublishTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.unpublishCta);
    expect(unpublishTrigger?.hasAttribute('disabled')).toBe(false);
    expect(container.textContent).not.toContain(koMessages.content.unpublishDisabledReason);
  });
});

// story 15e481ce(#3453 AC1) — 「Threads 변형 만들기」.
describe('ContentPostEditPage — 변형 만들기(story 15e481ce AC1)', () => {
  const ACTIVE_CONNECTION = { id: 'conn-1', channel: 'threads', account_label: '@sprintable_ai', status: 'active' };

  it('⭐활성 연결이 0건이면 「변형 만들기」 자리 자체가 안 그려진다(없는 자리를 그리지 않는다)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { activeConnections: [] });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-create-variant"]')).toBeNull();
  });

  it('⭐활성 연결이 있으면 선택지에 뜨고, 고른 뒤 만들면 work_item_id 재사용·source_content_item_id·text=summary로 POST된다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      activeConnections: [ACTIVE_CONNECTION],
      onCreateVariant: (body) => { capturedBody = body as Record<string, unknown>; return { status: 201, body: { draft_id: 'cp-1', version_id: 'cpv-1', version: 1 } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const select = container.querySelector('[data-testid="content-create-variant-connection-select"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'conn-1');
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const createBtn = container.querySelector('[data-testid="content-create-variant-button"]') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capturedBody?.work_item_id).toBe('w1');
    expect(capturedBody?.connection_id).toBe('conn-1');
    expect(capturedBody?.source_content_item_id).toBe(DRAFT_ID);
    expect(capturedBody?.text).toBe('요약입니다');
    expect(routerPushMock).toHaveBeenCalledWith('/content/channel-posts/cp-1');
  });

  it('summary가 비어 있으면 title로 폴백한다(text는 BE min_length=1이라 빈 문자열을 못 보낸다)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([{ ...VERSION_1, summary: '' }], undefined, undefined, {
      activeConnections: [ACTIVE_CONNECTION],
      onCreateVariant: (body) => { capturedBody = body as Record<string, unknown>; return { status: 201, body: { draft_id: 'cp-1', version_id: 'cpv-1', version: 1 } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const select = container.querySelector('[data-testid="content-create-variant-connection-select"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'conn-1');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const createBtn = container.querySelector('[data-testid="content-create-variant-button"]') as HTMLButtonElement;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capturedBody?.text).toBe('2호 글');
  });

  it('⭐422(CHANNEL_POST_SOURCE_CONTENT_ITEM_NOT_FOUND)는 서버 문장을 그대로 보인다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      activeConnections: [ACTIVE_CONNECTION],
      onCreateVariant: () => ({
        status: 422, body: { detail: { code: 'CHANNEL_POST_SOURCE_CONTENT_ITEM_NOT_FOUND', message: '원문을 찾을 수 없습니다: d1' } },
      }),
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const select = container.querySelector('[data-testid="content-create-variant-connection-select"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'conn-1');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const createBtn = container.querySelector('[data-testid="content-create-variant-button"]') as HTMLButtonElement;
    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // story 1db41045(#3457) — 유나 #3801 재판정 기록: 토글을 지워도 이전엔 이 테스트가
    // 초록이던 자리(raw는 캡처했지만 렌더 단언이 없었다). AlertDescription(<p>)으로
    // 사람 문장만 짚고, 토글 존재 자체도 별도로 pin한다.
    expect(container.querySelector('[data-testid="content-create-variant-error"] p')?.textContent)
      .toBe('원문을 찾을 수 없습니다: d1');
    const toggle = container.querySelector('[data-testid="content-create-variant-error"] details');
    expect(toggle?.querySelector('summary')?.textContent).toBe(koMessages.content.errorRawDetailsToggle);
    expect(toggle?.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ code: 'CHANNEL_POST_SOURCE_CONTENT_ITEM_NOT_FOUND', message: '원문을 찾을 수 없습니다: d1' }),
    );
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it('만들기 버튼은 연결을 고르기 전엔 비활성이다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { activeConnections: [ACTIVE_CONNECTION] });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    const createBtn = container.querySelector('[data-testid="content-create-variant-button"]') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  // 카디르 QA REQUEST_CHANGES(2026-09-04, PR#3799) — summary·title이 둘 다 공백뿐이면
  // (trim 前) title도 안 trim해 공백 1글자가 BE min_length=1을 그대로 통과해 버렸다.
  // 지금은 trim 후 둘 다 비면 POST 자체를 안 부르고 버튼 밖에 사유를 보인다.
  it('⭐summary·title이 공백뿐이면 POST를 안 부르고 버튼 밖에 사유가 뜬다(공백 1글자 통과 방지)', async () => {
    let createVariantCalled = false;
    stubFetchWithVersions([{ ...VERSION_1, summary: '   ', title: '   ' }], undefined, undefined, {
      activeConnections: [ACTIVE_CONNECTION],
      onCreateVariant: () => { createVariantCalled = true; return { status: 201, body: { draft_id: 'cp-1', version_id: 'cpv-1', version: 1 } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const select = container.querySelector('[data-testid="content-create-variant-connection-select"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'conn-1');
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const createBtn = container.querySelector('[data-testid="content-create-variant-button"]') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="content-create-variant-text-empty-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsCreateVariantTextEmptyReason);

    await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(createVariantCalled).toBe(false);
  });
});

// story 15e481ce(#3453 AC2, 유나 §14-2) — "같은 스토리의 채널 글"(역방향 목록).
describe('ContentPostEditPage — 같은 스토리의 채널 글(story 15e481ce AC2, §14-2)', () => {
  it('⭐변형이 0건이면 그 자리 자체가 안 그려진다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { variants: [] });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-variants-list"]')).toBeNull();
  });

  it('⭐변형이 있으면 채널·상태 칩과 함께 목록으로 뜨고, 각 항목이 그 변형 상세로 링크된다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      variants: [
        {
          draft_id: 'cp-1', channel: 'threads', gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
          publication_status: null, published_at: null,
        },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const item = container.querySelector('[data-testid="content-variants-list-item"]');
    expect(item?.querySelector('a')?.getAttribute('href')).toBe('/content/channel-posts/cp-1');
    expect(item?.textContent).toContain(koMessages.content.channelThreads);
    expect(item?.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('approved');
  });

  // 유나 사전 스티어(2026-09-04, PR#3799 head)① — 목록 머리에 개수를 보인다.
  it('목록 머리에 변형 개수가 보인다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      variants: [
        { draft_id: 'cp-1', channel: 'threads', connection_id: 'conn-1', gate_status: null, body_sha256: 'h1', publication_status: null, published_at: null },
        { draft_id: 'cp-2', channel: 'threads', connection_id: 'conn-2', gate_status: null, body_sha256: 'h2', publication_status: null, published_at: null },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-variants-list"] p')?.textContent)
      .toBe(`${koMessages.content.channelPostsVariantsListLabel} (2)`);
  });

  // 유나 사전 스티어② — published_at이 있으면 그 시각을 보인다(없으면 안 그림).
  it('published_at이 있는 변형은 발행 시각이 함께 보인다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      variants: [
        {
          draft_id: 'cp-1', channel: 'threads', connection_id: 'conn-1', gate_status: 'approved',
          sealed_content_sha256: 'h1', body_sha256: 'h1', publication_status: 'published',
          published_at: '2026-09-04T00:00:00Z',
        },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    const el = container.querySelector('[data-testid="content-variants-list-item-published-at"]');
    expect(el).not.toBeNull();
    expect(el?.textContent).not.toBe('');
  });

  // 유나 사전 스티어③ — 같은 채널의 연결이 둘이면 activeConnections에서 connection_id로
  // account_label을 이어 갈라 보인다(못 이으면 채널명만).
  it('⭐같은 채널 연결이 둘이면 account_label로 갈라 보이고, 연결을 못 찾으면 채널명만 보인다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      activeConnections: [
        { id: 'conn-1', channel: 'threads', account_label: '@brand_a', status: 'active' },
        { id: 'conn-2', channel: 'threads', account_label: '@brand_b', status: 'active' },
      ],
      variants: [
        { draft_id: 'cp-1', channel: 'threads', connection_id: 'conn-1', gate_status: null, body_sha256: 'h1', publication_status: null, published_at: null },
        { draft_id: 'cp-2', channel: 'threads', connection_id: 'conn-2', gate_status: null, body_sha256: 'h2', publication_status: null, published_at: null },
        { draft_id: 'cp-3', channel: 'threads', connection_id: 'conn-revoked', gate_status: null, body_sha256: 'h3', publication_status: null, published_at: null },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const items = [...container.querySelectorAll('[data-testid="content-variants-list-item"]')];
    expect(items[0]?.textContent).toContain('@brand_a');
    expect(items[1]?.textContent).toContain('@brand_b');
    expect(items[2]?.textContent).not.toContain('@brand');
    expect(items[2]?.textContent).toContain(koMessages.content.channelThreads);
  });
});

// story 1db41045(#3457) — 「캠페인 만들기/붙이기」.
describe('ContentPostEditPage — 캠페인 만들기/붙이기(story 1db41045)', () => {
  it('⭐campaign_id가 이미 있으면 "현재 캠페인" 이름+링크만 보이고, 만들기/붙이기 폼은 안 뜬다', async () => {
    stubFetchWithVersions([{ ...VERSION_1, campaign_id: 'c1', campaign_name: '9월 캠페인' }]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const el = container.querySelector('[data-testid="content-campaign-current"]');
    expect(el?.textContent).toContain('9월 캠페인');
    expect(el?.querySelector('a')?.getAttribute('href')).toBe('/campaigns/c1');
    expect(container.querySelector('[data-testid="content-campaign-attach"]')).toBeNull();
  });

  it('campaign_id가 없으면 만들기/붙이기 폼이 뜬다', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="content-campaign-attach"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-current"]')).toBeNull();
  });

  // 유나 정적 판정·PO 확認(2026-09-04 17:50Z) — 처음엔 site-posts 저장 POST(새
  // 버전)로 campaign_id를 실었으나 그 경로가 _reseal_gate_on_new_version으로
  // 승인을 무른다는 것이 드러나 PATCH .../campaign(버전 0·게이트 무접촉)로
  // 전환했다. PATCH body는 campaign_id 하나뿐이라 에디터 미저장 편집이
  // 구조적으로 아예 안 실린다(title 필드 자체가 body에 없다).
  it('⭐붙이기는 PATCH .../campaign을 부르고, body에 campaign_id 외 에디터 필드가 없다', async () => {
    let patchBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      onCreateCampaign: () => ({ status: 201, body: { id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active', created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00' } }),
      onPatchCampaign: (body) => { patchBody = body as Record<string, unknown>; return { status: 200, body: { draft_id: DRAFT_ID, campaign_id: 'c1', campaign_name: '9월 캠페인' } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    // 저장하지 않고 제목만 편집(미저장 상태 재현) — PATCH body 구조상 애초에 안 실린다.
    const titleInput = container.querySelector<HTMLInputElement>('#post-title');
    const titleSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    titleSetter?.call(titleInput, '미저장 편집 제목');
    titleInput?.dispatchEvent(new Event('input', { bubbles: true }));

    const nameInput = container.querySelector('[data-testid="content-campaign-new-name-input"]') as HTMLInputElement;
    const nameSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nameSetter?.call(nameInput, '9월 캠페인');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = container.querySelector('[data-testid="content-campaign-attach-button"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(patchBody).toEqual({ campaign_id: 'c1' });
    // PATCH 성공 응답의 campaign_name이 그대로 "현재 캠페인" 표시에 반영된다(재조회 없이).
    expect(container.querySelector('[data-testid="content-campaign-current"]')?.textContent).toContain('9월 캠페인');
  });

  it('⭐새 이름을 입력해 만들면 POST /campaigns 뒤 그 id로 PATCH .../campaign이 불린다', async () => {
    let patchBody: Record<string, unknown> | undefined;
    let createBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      onCreateCampaign: (body) => { createBody = body as Record<string, unknown>; return { status: 201, body: { id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active', created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00' } }; },
      onPatchCampaign: (body) => { patchBody = body as Record<string, unknown>; return { status: 200, body: { draft_id: DRAFT_ID, campaign_id: 'c1', campaign_name: '9월 캠페인' } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const input = container.querySelector('[data-testid="content-campaign-new-name-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '9월 캠페인');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = container.querySelector('[data-testid="content-campaign-attach-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createBody?.name).toBe('9월 캠페인');
    expect(patchBody).toEqual({ campaign_id: 'c1' });
  });

  it('기존 캠페인을 select로 고르면(새 이름 없이) 그 campaign_id로 PATCH가 불리고, 만들기 POST는 안 부른다', async () => {
    let patchBody: Record<string, unknown> | undefined;
    let createCalled = false;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      campaigns: [{ id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active', created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00' }],
      onCreateCampaign: () => { createCalled = true; return { status: 201, body: {} }; },
      onPatchCampaign: (body) => { patchBody = body as Record<string, unknown>; return { status: 200, body: { draft_id: DRAFT_ID, campaign_id: 'c1', campaign_name: '9월 캠페인' } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const select = container.querySelector('[data-testid="content-campaign-select"]') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'c1');
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const btn = container.querySelector('[data-testid="content-campaign-attach-button"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createCalled).toBe(false);
    expect(patchBody).toEqual({ campaign_id: 'c1' });
  });

  it('⭐새 이름을 넣었는데 생성이 실패(422)하면 에러가 보이고 PATCH는 안 부른다', async () => {
    let patchCalled = false;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      onCreateCampaign: () => ({ status: 422, body: { detail: { code: 'SOME_CAMPAIGN_ERROR', message: '캠페인 생성 실패 원문' } } }),
      onPatchCampaign: () => { patchCalled = true; return { status: 200, body: { draft_id: DRAFT_ID, campaign_id: 'c1', campaign_name: '9월 캠페인' } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const input = container.querySelector('[data-testid="content-campaign-new-name-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '9월 캠페인');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = container.querySelector('[data-testid="content-campaign-attach-button"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(patchCalled).toBe(false);
    expect(container.querySelector('[data-testid="content-campaign-attach-error"] p')?.textContent).toBe('캠페인 생성 실패 원문');
  });

  it('붙이기 버튼은 이름도 안 쓰고 기존도 안 고르면 비활성이다', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="content-campaign-attach-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // 페드루 PO N1 — campaign_name이 없으면 UUID를 사람 문장에 그대로 보이지 않는다.
  it('campaign_name이 없으면 UUID 대신 "이름 확인 불가" 문구가 보인다', async () => {
    stubFetchWithVersions([{ ...VERSION_1, campaign_id: 'c1', campaign_name: null }]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const el = container.querySelector('[data-testid="content-campaign-current"]');
    expect(el?.textContent).toContain(koMessages.content.campaignNameUnknown);
    expect(el?.textContent).not.toContain('c1');
  });
});

// 페드루 PO B2(2026-09-04 17:39Z) — 붙인 뒤 「변경」·「해제」 표면.
describe('ContentPostEditPage — 캠페인 변경/해제(story 1db41045 B2)', () => {
  it('⭐campaign_id가 있으면 "변경"·"해제" 버튼이 뜬다', async () => {
    stubFetchWithVersions([{ ...VERSION_1, campaign_id: 'c1', campaign_name: '9월 캠페인' }]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="content-campaign-change-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-detach-button"]')).not.toBeNull();
  });

  // 페드루 PO 재판정(2026-09-04 18:12Z) — 처음엔 「변경」이 현재 캠페인 줄을 폼으로
  // 통째로 대체해 "무엇에서 무엇으로"가 사라졌다. 지금은 변경 중에도 현재 캠페인
  // 줄(이름+링크)은 남고 그 아래 폼이 더 뜬다 — 변경/해제 버튼만 그 사이엔 숨는다.
  it('⭐"변경"을 누르면 현재 캠페인 줄은 남은 채 그 아래 붙이기 폼이 더 뜨고(취소 가능)', async () => {
    stubFetchWithVersions([{ ...VERSION_1, campaign_id: 'c1', campaign_name: '9월 캠페인' }]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const changeBtn = container.querySelector('[data-testid="content-campaign-change-button"]') as HTMLButtonElement;
    await act(async () => { changeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.querySelector('[data-testid="content-campaign-attach"]')).not.toBeNull();
    const current = container.querySelector('[data-testid="content-campaign-current"]');
    expect(current).not.toBeNull();
    expect(current?.textContent).toContain('9월 캠페인');
    // 변경 중엔 변경/해제 버튼은 숨는다(같은 화면에 "지금 바꾸는 중"과 "바꾸기/
    // 해제" 액션이 겹쳐 뜨지 않게).
    expect(container.querySelector('[data-testid="content-campaign-change-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-detach-button"]')).toBeNull();

    const cancelBtn = container.querySelector('[data-testid="content-campaign-cancel-change-button"]') as HTMLButtonElement;
    await act(async () => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.querySelector('[data-testid="content-campaign-current"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-attach"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-change-button"]')).not.toBeNull();
  });

  it('⭐"해제"를 누르면 PATCH .../campaign에 campaign_id: null을 명시로 보낸다(버전 0)', async () => {
    let patchBody: Record<string, unknown> | undefined;
    stubFetchWithVersions(
      [{ ...VERSION_1, campaign_id: 'c1', campaign_name: '9월 캠페인' }],
      undefined, undefined,
      { onPatchCampaign: (body) => { patchBody = body as Record<string, unknown>; return { status: 200, body: { draft_id: DRAFT_ID, campaign_id: null, campaign_name: null } }; } },
    );
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const detachBtn = container.querySelector('[data-testid="content-campaign-detach-button"]') as HTMLButtonElement;
    await act(async () => { detachBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(patchBody).toEqual({ campaign_id: null });
    // 해제 성공 응답이 그대로 반영돼 붙이기 폼이 다시 보인다(재조회 없이).
    expect(container.querySelector('[data-testid="content-campaign-attach"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-campaign-current"]')).toBeNull();
  });
});

// story #3483(BE 3482 계약, 유나 §16-7 정본) — 원문(site_post) 초안 화면 규칙 위반.
// BE 3482가 아직 병합 前이라 stub fetch로 계약(violations[].field ∈ {title,summary,
// body_md}, 나머지 shape은 3472 2부와 동일)만 먼저 검증한다. 라이브는 3482 착지 뒤.
describe('ContentPostEditPage — 콘텐츠 규칙 위반 표시(story #3483, §16-7)', () => {
  it('⭐저장 응답의 violations[] — title/summary/body_md 세 갈래로 각각 그 필드 아래에만', async () => {
    stubFetchWithVersions([VERSION_1], () => ({
      status: 201,
      body: {
        draft_id: DRAFT_ID, version_id: 'v2', version: 2,
        violations: [
          { code: 'banned_term', field: 'title', value: '무료체험', hint_key: 'x', settings_path: '/organization/content-rules' },
          { code: 'banned_term', field: 'summary', value: '광고', hint_key: 'x', settings_path: '/organization/content-rules' },
          { code: 'banned_term', field: 'body_md', value: '즉시할인', hint_key: 'x', settings_path: '/organization/content-rules' },
        ],
      },
    }));
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta) as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const titleViolation = container.querySelector('[data-testid="content-rule-violation-title"]');
    const summaryViolation = container.querySelector('[data-testid="content-rule-violation-summary"]');
    const bodyViolation = container.querySelector('[data-testid="content-rule-violation-body-md"]');
    expect(titleViolation?.textContent).toContain('무료체험');
    expect(summaryViolation?.textContent).toContain('광고');
    expect(bodyViolation?.textContent).toContain('즉시할인');
    // 서로 새지 않는다(제목 위반이 요약 자리에 안 뜸 등).
    expect(titleViolation?.textContent).not.toContain('광고');
  });

  it('⭐위반이 있으면 상신 버튼이 비활성이고, 버튼 밖에 개수가 뜬다', async () => {
    stubFetchWithVersions([VERSION_1], () => ({
      status: 201,
      body: { violations: [{ code: 'banned_term', field: 'title', value: 'x', hint_key: 'x', settings_path: '/organization/content-rules' }] },
    }));
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta) as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="content-rule-violation-blocked-reason"]')?.textContent)
      .toBe(koMessages.content.contentRuleSubmitBlockedHint.replace('{count}', '1'));
  });

  it('⭐상신 422 CONTENT_RULE_VIOLATION — 새 배너를 안 만들고 필드 옆 목록만 갱신한다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, () => ({
      status: 422,
      body: { error: { code: 'CONTENT_RULE_VIOLATION', rules_version: 3, violations: [{ code: 'banned_term', field: 'body_md', value: 'y', hint_key: 'x', settings_path: '/organization/content-rules' }] } },
    }));
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="content-rule-violation-body-md"]')?.textContent).toContain('y');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('위반이 없으면 저장·상신이 평소대로(회귀 0)', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-rule-violation-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-rule-violation-blocked-reason"]')).toBeNull();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
  });

  // story #3514(lint-on-read, doc a0da40c9, PO 確定 2026-09-05) — 유나 13회차 ③ 관찰:
  // 규칙이 바뀐 뒤 기존 초안을 «열기만» 하면(저장·상신 없이) 위반 목록·상신 비활성이
  // 이미 서야 한다. 위 세 테스트는 전부 저장/상신 응답에서 violations를 갱신하는
  // 경로만 검증했다 — 이 테스트는 그 축과 별개로 «로드 한 번»만으로 §16-7 픽셀이
  // 서는지를 잰다(저장·상신 버튼을 누르지 않는다).
  it('⭐로드만으로(저장·상신 없이) 단건 GET의 violations가 필드 옆 목록·상신 비활성으로 선다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      draftViolations: [
        { code: 'banned_term', field: 'title', value: '무료체험', hint_key: 'x', settings_path: '/organization/content-rules' },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    // 저장·상신 버튼을 누르지 않았다 — 그런데도 위반이 이미 보인다.
    expect(container.querySelector('[data-testid="content-rule-violation-title"]')?.textContent).toContain('무료체험');
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="content-rule-violation-blocked-reason"]')?.textContent)
      .toBe(koMessages.content.contentRuleSubmitBlockedHint.replace('{count}', '1'));
  });

  it('단건 GET에 violations가 없으면(계약 없음·BE 미착지) 빈 배열로 안전 폴백한다(지어내지 않는다)', async () => {
    stubFetchWithVersions([VERSION_1]); // draftViolations 생략 — 기본값 [].
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-rule-violation-title"]')).toBeNull();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
  });

  // story #3514(유나 Design 변경요청 1, 2026-09-05) — 단건 GET은 이 화면에서 부수
  // 데이터(주 데이터는 /versions)라 그 실패가 초안 열기 자체를 막으면 안 된다.
  it('⭐단건 GET 500 — 본문(제목·요약 등)은 그대로 뜨고 violations=0+안내 한 줄만 뜬다(loadError 아님)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { draftStatus: 500 });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    // 화면이 안 막혔다 — /versions의 제목이 정상적으로 폼에 실렸다.
    const titleInput = container.querySelector('#post-title') as HTMLInputElement | null;
    expect(titleInput?.value).toBe(VERSION_1.title);
    expect(container.querySelector('[data-testid="content-rule-violation-title"]')).toBeNull();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false); // violations=[]라 상신 자체는 안 막힌다.
    expect(container.querySelector('[data-testid="content-rule-violation-load-failed"]')?.textContent)
      .toBe(koMessages.content.contentRuleViolationsLoadFailed);
  });

  // story #3514(PO REQUIRED, 2026-09-05) — 저장 응답이 violations를 권위 값으로
  // 채운 뒤에는 "불러오지 못했습니다" 줄이 그 곁에 남아 모순되면 안 된다.
  it('⭐단건 GET 500 뒤에도 저장에 성공하면 안내 줄이 사라진다(권위 값이 덮어씀)', async () => {
    stubFetchWithVersions([VERSION_1], () => ({ status: 201, body: { violations: [] } }), undefined, { draftStatus: 500 });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="content-rule-violation-load-failed"]')).not.toBeNull();

    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.editSaveCta) as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="content-rule-violation-load-failed"]')).toBeNull();
  });

  // story #3514(유나 실측 후속, §16-7 2부, 2026-09-05) — 단건 GET이 "응답은 왔는데
  // 실패"(4xx/5xx)가 아니라 "응답이 안 옴"(연결 끊김·abort, fetch 자체가 reject)이면
  // Promise.all에 그대로 섞여 있을 때 전체가 거절돼 loadError로 화면 전체가 막혔었다
  // (§16-7이 "나란히 부르되 같은 급으로 묶지 않는다"고 정한 것의 위반). 단건 GET만
  // .catch(() => null)로 격리해 이 갈래도 draftStatus와 동일하게 취급되는지 고정.
  it('⭐단건 GET reject(네트워크 오류) — 본문은 그대로 뜨고 violations=0+안내 한 줄, loadError 아님', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, { draftReject: true });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const titleInput = container.querySelector('#post-title') as HTMLInputElement | null;
    expect(titleInput?.value).toBe(VERSION_1.title);
    expect(container.querySelector('[data-testid="content-rule-violation-title"]')).toBeNull();
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(container.querySelector('[data-testid="content-rule-violation-load-failed"]')?.textContent)
      .toBe(koMessages.content.contentRuleViolationsLoadFailed);
  });
});

// story #3479(BE #3476/#3828 실물 계약, 페드루 PO 確定 2026-09-05) — 원문 상세
// «발행 결과» 줄, 외부 목적지(WordPress·webhook). 4표본 그대로 pin.
describe('ContentPostEditPage — 외부 목적지 발행 결과(story #3479, 런북 A-7)', () => {
  it('⭐destination=wordpress + channel_publication published + permalink — 링크 href=permalink', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        destination: 'wordpress',
        channel_publication: {
          status: 'published', external_id: 'post-123', permalink: 'https://blog.example.com/hello',
          published_at: '2026-09-05T00:00:00Z', unpublished_at: null, last_error: null,
        },
        command: { id: 'cmd-1', command_status: 'completed', attempt_count: 1, failure_kind: null, next_retry_at: null, dead_letter_at: null, command_reason_code: null, last_error: null },
      },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    const info = container.querySelector('[data-testid="content-external-publication-info"]');
    expect(info).not.toBeNull();
    expect(info?.textContent).toContain(koMessages.content.channelLabelWordpress);
    const link = info?.querySelector<HTMLAnchorElement>('a[href="https://blog.example.com/hello"]');
    expect(link).not.toBeNull();
    // completed엔 보일 실패가 없다 — FailureActionBadge 자체가 안 뜬다(가짜 상태 금지).
    expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
  });

  it('hosted_site(현행) — 외부 목적지 블록이 안 뜬다(회귀 0)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: null, published_body_sha256: null,
        destination: 'hosted_site',
      },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="content-publication-info"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-external-publication-info"]')).toBeNull();
  });

  it('⭐command dead_letter — FailureActionBadge 재시도 버튼 클릭 → 공용 BFF(publication-commands/{id}/retry) 호출', async () => {
    let retried: string | null = null;
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        destination: 'webhook',
        channel_publication: null,
        command: { id: 'cmd-1', command_status: 'dead_letter', attempt_count: 5, failure_kind: 'needs_check', next_retry_at: null, dead_letter_at: '2026-09-05T00:00:00Z', command_reason_code: null, last_error: 'timeout' },
      },
      onRetryPublicationCommand: (commandId) => { retried = commandId; return { status: 200, body: { id: commandId, status: 'pending' } }; },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.disabled).toBe(false);
    await act(async () => { retryBtn.click(); });
    await flush();

    expect(retried).toBe('cmd-1');
  });

  it('⭐카디르군 REQUEST_CHANGES(2026-09-05) — permalink이 null이면(아직 미발행) 「공개 URL」 라벨을 포함해 그 행 전체가 안 보인다(<a> 부재만으론 안 잡히던 회귀)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        destination: 'wordpress',
        channel_publication: { status: 'container_created', external_id: null, permalink: null, published_at: null, unpublished_at: null, last_error: null },
        command: { id: 'cmd-1', command_status: 'pending', attempt_count: 0, failure_kind: null, next_retry_at: null, dead_letter_at: null, command_reason_code: null, last_error: null },
      },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    const info = container.querySelector('[data-testid="content-external-publication-info"]')!;
    expect(info.querySelector('a')).toBeNull();
    // <a> 부재만 재면 라벨+「—」 잔존을 못 잡는다 — 라벨 텍스트 자체가 없어야 한다.
    expect(info.textContent).not.toContain(koMessages.content.publishedInfoUrlLabel);
  });

  it('⭐PO 보정(2026-09-05, PR#3830) — 회수된 글(status=unpublished)은 회수됨 문구+회수 시각을 보이고, permalink는 사실이니 그대로 링크로 남는다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        destination: 'wordpress',
        channel_publication: {
          status: 'unpublished', external_id: 'post-123', permalink: 'https://blog.example.com/hello',
          published_at: '2026-09-01T00:00:00Z', unpublished_at: '2026-09-04T00:00:00Z', last_error: null,
        },
        command: null,
      },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    const info = container.querySelector('[data-testid="content-external-publication-info"]')!;
    expect(info.textContent).toContain(koMessages.content.externalPublicationStatusUnpublished);
    // 발행 이후 회수된 것도 사실이라 permalink는 그대로 링크로 남는다("아직 실려
    // 있다"로 읽히는 것을 막는 건 상태 문구의 몫이지, 링크를 지우는 게 아니다).
    expect(info.querySelector('a[href="https://blog.example.com/hello"]')).not.toBeNull();
    const expectedTz = resolveDisplayTimezone().tz;
    expect(info.textContent).toContain(formatScheduledAt('2026-09-04T00:00:00Z', expectedTz).display);
  });
});

describe('ContentPostEditPage — 성과 인사이트 블록(story #3499, BE #3844 조각4 의존)', () => {
  it('publication_id 없음(BE 미착지 응답) — 인사이트 블록 자체를 안 그린다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: null, published_body_sha256: null, destination: 'hosted_site',
      },
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="content-insight-info"]')).toBeNull();
  });

  it('hosted_site publication_id 있음 — 인사이트 블록을 그리고 서버 값을 그대로 보인다(조립·판정 0)', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
        published_by_member_id: null, published_body_sha256: null, destination: 'hosted_site',
        publication_id: 'sp-1',
      },
      insightSnapshots: [
        {
          normalized: { impressions: 100, reach: null, views: 0, engagements: null, clicks: null, spend: null, conversions: null },
          captured_at: '2026-09-04T00:00:00Z', status: 'captured', due_at: '2026-09-04T00:00:00Z', source: 'hosted_site',
        },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    const info = container.querySelector('[data-testid="content-insight-info"]');
    expect(info).not.toBeNull();
    const values = Array.from(info!.querySelectorAll('[data-testid="insight-metric-value"]')).map((el) => el.textContent);
    expect(values).toContain('100');
    expect(values).toContain('0');
    expect(info!.textContent).toContain(koMessages.content.insightMetricUnavailableDash);
  });

  it('외부 목적지 publication_id(channel_publication 축) 있음 — 인사이트 블록을 그린다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, undefined, {
      publication: {
        published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        destination: 'wordpress',
        channel_publication: {
          status: 'published', external_id: 'post-123', permalink: 'https://blog.example.com/hello',
          published_at: '2026-09-05T00:00:00Z', unpublished_at: null, last_error: null, publication_id: 'cp-1',
        },
        command: null,
      },
      insightSnapshots: [
        {
          normalized: { impressions: null, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null },
          captured_at: null, status: 'pending', due_at: '2026-09-06T00:00:00Z', source: 'wordpress',
        },
      ],
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    await flush();

    expect(container.querySelector('[data-testid="content-insight-info"]')).not.toBeNull();
  });
});

describe('ContentPostEditPage — 생성 비용 한도(story #3500, doc a0da40c9 §19 — BE #3498 미착지, 계약 fixture)', () => {
  it('예상 비용을 입력하지 않으면 submit body에 estimated_cost_minor가 없다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, (body) => {
      capturedBody = body as Record<string, unknown>;
      return { status: 200, body: { gate_id: 'gate-1' } };
    });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capturedBody?.estimated_cost_minor).toBeUndefined();
  });

  it('⭐예상 비용을 입력하면(KRW, exponent 0) 큰단위 그대로 분단위로 실린다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, (body) => {
      capturedBody = body as Record<string, unknown>;
      return { status: 200, body: { gate_id: 'gate-1' } };
    }, { genBudget: { limit_minor: 100000, spent_minor: 0, remaining_minor: 100000, currency: 'KRW', period: 'month' } });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="content-estimated-cost-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(costInput, '5000');
      costInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capturedBody?.estimated_cost_minor).toBe(5000);
  });

  it('⭐예상 비용을 입력하면(USD, exponent 2) 큰단위×100이 분단위로 실린다(§19-1 회귀 방지)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    stubFetchWithVersions([VERSION_1], undefined, (body) => {
      capturedBody = body as Record<string, unknown>;
      return { status: 200, body: { gate_id: 'gate-1' } };
    }, { genBudget: { limit_minor: 100000, spent_minor: 0, remaining_minor: 100000, currency: 'USD', period: 'month' } });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="content-estimated-cost-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      // 큰단위로 "5"(=$5)를 입력 — exponent 변환을 빼먹으면 500이 아닌 5가 그대로
      // 실려 이 단언이 깨진다.
      setter?.call(costInput, '5');
      costInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(capturedBody?.estimated_cost_minor).toBe(500);
  });

  it('⭐422 GENERATION_BUDGET_EXCEEDED — 구조화 배너(사실→4값→행동)가 뜨고 입력값은 지워지지 않는다', async () => {
    stubFetchWithVersions([VERSION_1], undefined, () => ({
      status: 422,
      body: { detail: { code: 'GENERATION_BUDGET_EXCEEDED', limit_minor: 100000, spent_minor: 90000, estimated_cost_minor: 20000, remaining_minor: 10000 } },
    }), { genBudget: { limit_minor: 100000, spent_minor: 90000, remaining_minor: 10000, currency: 'KRW', period: 'month' } });
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="content-estimated-cost-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(costInput, '20000');
      costInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.submitCta);
    await act(async () => { submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const banner = container.querySelector('[data-testid="generation-budget-exceeded-banner"]');
    expect(banner?.textContent).toContain(koMessages.content.generationBudgetExceededFact);
    expect(container.querySelector('[data-testid="generation-budget-exceeded-limit"]')?.textContent).toBe('100,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-spent"]')?.textContent).toBe('90,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-estimated"]')?.textContent).toBe('20,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-remaining"]')?.textContent).toBe('10,000원');
    expect(banner?.textContent).toContain(koMessages.content.generationBudgetExceededAction);
    expect(costInput.value).toBe('20000');
  });

  it('정책 미설정(limit_minor=null)이면 상신 표면에 잔량 표시가 아무것도 안 뜬다', async () => {
    stubFetchWithVersions([VERSION_1]);
    await act(async () => { root.render(wrap(<ContentPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="generation-budget-remaining-compact"]')).toBeNull();
  });
});
