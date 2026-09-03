// @vitest-environment jsdom
//
// story #3368(Phase0·마케팅운영 S4) — 글 편집(S3). AC2 pin: 저장하면 새 버전 번호와
// "미상신"(초안) 상태가 표시되고, slug·lang은 잠겨(표시만, 입력란 없음) 재전송된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
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
    publication?: { published_at: string | null; url: string | null; published_by_member_id: string | null; published_body_sha256: string | null };
    onUnpublish?: () => { status: number; body: unknown };
    // 페드루 PO 리뷰(2026-09-03) — 발행자 UUID→이름 해소(gates/[id]/page.tsx의
    // memberNames 관례 재사용). 기본값 빈 배열 — 개별 테스트가 필요할 때만 넘긴다(넘기지
    // 않으면 published_by_member_id가 그대로 앞 8자 폴백으로 렌더된다, 그 자체도 유효한
    // graceful-degradation 케이스).
    teamMembers?: { id: string; name: string }[];
  },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: versions, error: null, meta: null }) };
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
        // 덮는다.
        const body = opts?.publication ?? {
          published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
        };
        return { ok: true, status: 200, json: async () => ({ data: body, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/site-posts/drafts/${DRAFT_ID}/unpublish` && init?.method === 'POST') {
        const result = opts?.onUnpublish?.() ?? { status: 200, body: { id: 'p1', slug: '2ho-blog', unpublished_at: '2026-09-05T01:00:00Z' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === '/api/team-members') {
        return { ok: true, status: 200, json: async () => ({ data: opts?.teamMembers ?? [], error: null, meta: null }) };
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
