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
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [] });
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
  opts?: { gates?: unknown[]; onPublish?: () => { status: number; body: unknown } },
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
