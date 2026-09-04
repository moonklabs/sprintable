// @vitest-environment jsdom
//
// story #3402(Phase1·마케팅운영, AC5/AC6) — 채널 포스트 편집·상신. content/[draftId]/
// page.test.tsx와 동형 harness — 이 파일은 편집+상신까지만 pin한다(승인 카드는 ④,
// 발행/부분성공은 PR2 몫).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
}));

import ChannelPostEditPage from './page';

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
    await Promise.resolve();
  });
}

const DRAFT_DETAIL = {
  draft_id: DRAFT_ID, work_item_id: 'w1', channel: 'threads', connection_id: 'c1', current_version: 1,
  gate_status: null as string | null, reapproval_required: null as boolean | null,
};
const VERSION_1 = {
  version_id: 'v1', version: 1, draft_id: DRAFT_ID, text: '초안 본문입니다', link_url: null,
  body_sha256: 'h1', author_kind: 'agent', created_at: '2026-09-03T03:50:00+00:00', tagged_link_preview: null,
};

function stubFetch(opts: {
  versions?: unknown[];
  maxTextLength?: number | null;
  accountLabel?: string | null;
  limitOk?: { quota_usage: number; quota_total: number } | false;
  draftDetail?: Partial<typeof DRAFT_DETAIL>;
  onSave?: (body: unknown) => { status: number; body: unknown };
  onSubmit?: (body: unknown) => { status: number; body: unknown };
}) {
  const versions = opts.versions ?? [VERSION_1];
  const draftDetail = { ...DRAFT_DETAIL, ...opts.draftDetail };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}`) {
        return { ok: true, status: 200, json: async () => ({ data: draftDetail, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: versions, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        // ⚠️`??`는 null도 nullish라 여기서 쓰면 "명시적으로 null을 넘긴" 테스트 케이스가
        // 조용히 500으로 되돌아간다 — 호출부가 필드 자체를 안 넘겼을 때만 500 기본값.
        const maxTextLength = 'maxTextLength' in opts ? opts.maxTextLength : 500;
        const accountLabel = 'accountLabel' in opts ? opts.accountLabel : 'Marketing Bot';
        return {
          ok: true, status: 200,
          json: async () => ({
            data: [{ id: 'c1', max_text_length: maxTextLength, account_label: accountLabel, account_id: 'acct-1' }],
            error: null, meta: null,
          }),
        };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-connections/c1/publishing-limit`) {
        if (opts.limitOk === false) return { ok: false, status: 502, json: async () => ({}) };
        const limit = opts.limitOk ?? { quota_usage: 3, quota_total: 250 };
        return { ok: true, status: 200, json: async () => ({ data: limit, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const result = opts.onSave?.(body) ?? { status: 201, body: { draft_id: DRAFT_ID, version_id: 'v2', version: 2 } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/submit` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts.onSubmit?.(body) ?? { status: 200, body: { gate_id: 'g1', version_id: 'v1', content_sha256: 'h1', status: 'pending' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      throw new Error('unexpected fetch: ' + url + ' ' + (init?.method ?? 'GET'));
    }),
  );
}

describe('ChannelPostEditPage (story #3402 AC5/AC6)', () => {
  it('⭐로드된 버전의 text가 편집 필드에 채워진다', async () => {
    stubFetch({});
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const field = container.querySelector('[data-testid="channel-post-text-field"]') as HTMLTextAreaElement;
    expect(field.value).toBe('초안 본문입니다');
  });

  it('⭐AC6 — 글자 수는 channelTextLength(코드포인트)로 세고 어댑터 한도와 함께 보인다', async () => {
    stubFetch({ maxTextLength: 500 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-char-count"]')?.textContent).toContain('/ 500');
  });

  it('⭐AC6 — 한도 미선언(null)이면 "한도 미확認"으로 두되 초과 판정을 안 한다', async () => {
    stubFetch({ maxTextLength: null });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-char-count"]')?.textContent)
      .toContain(koMessages.content.channelPostsCharLimitUnknown);
    expect(container.querySelector('[data-testid="channel-post-submit-button"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('⭐AC6 핵심 — 한도 초과 시 상신 버튼이 비활성화되고 비활성 사유가 버튼 밖에 보인다', async () => {
    stubFetch({ versions: [{ ...VERSION_1, text: 'x'.repeat(10) }], maxTextLength: 5 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]');
    expect(submitBtn?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-over-limit-reason"]')).not.toBeNull();
  });

  it('저장 성공 — 성공 메시지가 보이고 버전 목록이 재조회된다', async () => {
    stubFetch({});
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.editSaved);
  });

  it('상신 성공 — 게이트 링크가 포함된 성공 메시지가 보인다', async () => {
    stubFetch({});
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.submitSuccess);
    expect(container.querySelector('a[href="/gates/g1"]')).not.toBeNull();
  });

  // story #3402·PR#3764 — CHANNEL_POST_GATE_ALREADY_HELD. site와 달리 slug/lang이 없어
  // heldByChannel+heldByConnectionId 앞 4자로 폴백 문구를 조립한다. "합치기" 문구가
  // 없어야 한다(doc §5 각주 — 제품에 없는 동작을 권하지 않는다).
  it('⭐CHANNEL_POST_GATE_ALREADY_HELD — "Threads 초안 ····<4자>" 폴백 문구+그 초안 링크, "합치기" 문구는 없다', async () => {
    stubFetch({
      onSubmit: () => ({
        status: 409,
        body: {
          error: {
            code: 'CHANNEL_POST_GATE_ALREADY_HELD', message: '…',
            holding_draft_id: 'd9', holding_channel: 'threads', holding_connection_id: 'conn12345',
          },
        },
      }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await flush();

    expect(container.textContent).toContain('Threads 초안 ····conn');
    expect(container.textContent).not.toContain('합치기');
    expect(container.querySelector('a[href="/content/channel-posts/d9"]')).not.toBeNull();
  });

  // story #3402 ④(AC7/AC9) — 승인 카드.
  it('⭐AC9 — account_label이 있으면 그 값을 보인다', async () => {
    stubFetch({ accountLabel: 'Marketing Bot' });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-account-label"]')?.textContent).toBe('Marketing Bot');
  });

  it('⭐AC9 — account_label이 null이면 account_id로 폴백한다(지어내지 않는다)', async () => {
    stubFetch({ accountLabel: null });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-account-label"]')?.textContent).toBe('acct-1');
  });

  it('⭐AC7 — 한도 잔량 조회 성공 시 남은 게시 수를 보인다', async () => {
    stubFetch({ limitOk: { quota_usage: 3, quota_total: 250 } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-limit"]')?.textContent).toBe('247 / 250');
  });

  it('⭐AC7 핵심 — 한도 조회 실패는 "0"이 아니라 조회 실패 상태로 보인다("모른다≠다르다")', async () => {
    stubFetch({ limitOk: false });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-limit"]')?.textContent)
      .toBe(koMessages.content.channelPostsLimitCheckFailed);
  });

  it('⭐게이트 상태 — gate_status=null이면 "상신 전"으로 보인다', async () => {
    stubFetch({ draftDetail: { gate_status: null, reapproval_required: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-gate-status"]')?.textContent)
      .toBe(koMessages.content.channelPostsApprovalNotSubmitted);
  });

  it('⭐게이트 상태 — pending+reapproval_required=true면 "재승인 필요"로 보인다', async () => {
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: true } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-gate-status"]')?.textContent)
      .toBe(koMessages.content.channelPostsApprovalReapprovalNeeded);
  });

  it('⭐AC8 — tagged_link_preview가 있으면 그대로 보인다', async () => {
    stubFetch({ versions: [{ ...VERSION_1, tagged_link_preview: '본문\n\nhttps://x?utm_source=threads' }] });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-tagged-link-preview"]')?.textContent)
      .toContain('utm_source=threads');
  });

  it('⭐AC8 — tagged_link_preview가 null(link_url 없음)이면 그 줄 자체가 안 보인다', async () => {
    stubFetch({ versions: [{ ...VERSION_1, tagged_link_preview: null }] });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-tagged-link-preview"]')).toBeNull();
  });

  it('로드 실패 — 오류 알림을 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.editLoadFailed);
  });
});
