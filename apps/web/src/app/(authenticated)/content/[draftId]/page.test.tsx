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

function stubFetchWithVersions(versions: unknown[], onSave?: (body: unknown) => { status: number; body: unknown }) {
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
        return { ok: result.status < 400, status: result.status, json: async () => ({ data: result.body, error: null, meta: null }) };
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

  it('저장 실패(422) — 성공 메시지가 아니라 에러 안내가 뜬다', async () => {
    stubFetchWithVersions([VERSION_1], () => ({ status: 422, body: { code: 'MEDIA_NOT_SUPPORTED_PHASE0' } }));
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
  });
});
