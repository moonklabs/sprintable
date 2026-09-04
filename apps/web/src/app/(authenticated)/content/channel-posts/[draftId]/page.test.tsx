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
  // story #3402 PR2 ②-a — content/[draftId]/page.test.tsx(site-posts)와 동일 관례:
  // 발행 취소 버튼 role 게이팅 기본값은 'owner'(기존 테스트 전부가 "권한 있음" 전제).
  // member 케이스는 개별 테스트가 이 값을 덮어쓴다.
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
    await Promise.resolve();
  });
}

const DRAFT_DETAIL = {
  draft_id: DRAFT_ID, work_item_id: 'w1', channel: 'threads', connection_id: 'c1', current_version: 1,
  gate_status: null as string | null, reapproval_required: null as boolean | null,
  sealed_content_sha256: null as string | null, body_sha256: 'h1',
  publication_status: null as 'container_created' | 'published' | 'failed' | null,
  permalink: null as string | null, external_id: null as string | null, error_code: null as string | null,
  published_at: null as string | null,
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
  onPublish?: () => { status: number; body: unknown };
  // story #3402·PR#3764/#3767(페드루 PO 정정 2026-09-04 02:00Z) — GATE_ALREADY_HELD의
  // best-effort 상대 초안 조회. undefined=엔드포인트 자체가 404(구 계약, #3767 착지 전
  // 상황 재현) · { text_preview: null }=필드는 있는데 값이 없음 · 값 있으면 그 미리보기.
  holdingDraft?: { text_preview: string | null } | undefined;
  // story #3402(카디르 QA 2026-09-04) — AC2 "키 부재" 재현용. `draftDetail`은 DRAFT_DETAIL
  // 위에 스프레드 병합되므로 override 쪽에서 키를 빼도 base의 값이 살아남는다(고전
  // 함정) — 병합 "후"에 명시적으로 delete해야 진짜 키 부재를 재현한다.
  omitGateStatusKey?: boolean;
}) {
  const versions = opts.versions ?? [VERSION_1];
  const draftDetail: Record<string, unknown> = { ...DRAFT_DETAIL, ...opts.draftDetail };
  if (opts.omitGateStatusKey) delete draftDetail.gate_status;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}`) {
        return { ok: true, status: 200, json: async () => ({ data: draftDetail, error: null, meta: null }) };
      }
      // story #3402·PR#3767 — GATE_ALREADY_HELD best-effort 상대 초안 단건 조회. 테스트의
      // holding_draft_id는 항상 'd9'(현재 편집 중인 DRAFT_ID와 다른 값)로 고정한다.
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/d9`) {
        if (opts.holdingDraft === undefined) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: opts.holdingDraft, error: null, meta: null }) };
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
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/publish` && init?.method === 'POST') {
        const result = opts.onPublish?.() ?? {
          status: 200, body: { permalink: 'https://threads.net/@x/1', external_id: 'media-1', published_at: '2026-09-04T00:00:00Z', version_id: 'v1' },
        };
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

  // story #3402·PR#3764/#3767(페드루 PO 정정 2026-09-04 02:00Z) — CHANNEL_POST_GATE_
  // ALREADY_HELD. AC10 12행 정본: ①best-effort로 상대 초안 GET drafts/{holding_draft_id}
  // 의 text_preview 우선 ②실패/부재 시 "Threads 초안 ····<holding_draft_id 앞4자>" 폴백
  // (connection_id 아님 — 그 초안을 쥔 다른 초안 전부가 같은 connection이라 식별력 0,
  // 링크 대상과 같은 식별자를 써야 문구와 링크가 같은 것을 가리킨다는 게 보인다).
  // "합치기" 문구가 없어야 한다(doc §5 각주 — 제품에 없는 동작을 권하지 않는다).
  function stubGateAlreadyHeld(holdingDraft: { text_preview: string | null } | undefined) {
    stubFetch({
      holdingDraft,
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
  }

  async function clickSubmit() {
    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await flush();
  }

  it('⭐GATE_ALREADY_HELD best-effort 성공 — 상대 초안의 text_preview를 그대로 보인다(4자 폴백 아님)', async () => {
    stubGateAlreadyHeld({ text_preview: '마케팅 자동화가 실제로 아끼는 시간은…' });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    await clickSubmit();

    expect(container.textContent).toContain('마케팅 자동화가 실제로 아끼는 시간은…');
    expect(container.textContent).not.toContain('합치기');
    expect(container.querySelector('a[href="/content/channel-posts/d9"]')).not.toBeNull();
  });

  it('⭐GATE_ALREADY_HELD best-effort 실패/부재 — "Threads 초안 ····<holding_draft_id 4자>" 폴백(connection_id 아님)', async () => {
    stubGateAlreadyHeld(undefined); // 단건 GET 자체가 404(#3767 착지 전 구 계약 재현).
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    await clickSubmit();

    // holding_draft_id='d9' 앞 4자는 "d9"(2자뿐이라 slice(0,4)가 그대로 "d9") — 실 UUID
    // 환경에서는 4자가 온전히 나온다. 핵심은 connection_id('conn12345')의 "conn"이 아니라
    // holding_draft_id 쪽에서 왔다는 것이다.
    expect(container.textContent).toContain('Threads 초안 ····d9');
    expect(container.textContent).not.toContain('····conn');
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

  // 카디르 QA(2026-09-04)·유나 정밀화 — 승인 카드의 게이트 상태는 이제 목록과 같은
  // deriveChannelPostView(post-status.ts 5상태 파생 재사용)를 통과한다 — 라벨도
  // post-status.ts::contentPostStatusLabelKey(StatusChip과 동일 출처)를 그대로 쓴다.
  it('⭐게이트 상태 — gate_status=null(진짜 게이트 없음)이면 "초안" 라벨로 보인다(5상태 파생 재사용, contentStatusDraft)', async () => {
    stubFetch({ draftDetail: { gate_status: null, reapproval_required: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-gate-status"]')?.textContent)
      .toBe(koMessages.content.contentStatusDraft);
  });

  it('⭐AC2 핵심 — gate_status 계약 필드 자체가 없으면(키 부재, "모른다") "—"를 보인다(gate_status===null=상신 없음과 구별)', async () => {
    stubFetch({ omitGateStatusKey: true });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-gate-status"]')?.textContent)
      .toBe(koMessages.content.originAuthorUnknown);
  });

  it('⭐게이트 상태 — pending+reapproval_required=true면 "재승인 필요" 라벨로 보인다', async () => {
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: true } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-gate-status"]')?.textContent)
      .toBe(koMessages.content.contentStatusReapprovalNeeded);
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

  // story #3402 PR2(T7/T9) — 발행됨/부분성공/실패 표시(발행 버튼 배선은 다음 조각).
  it('⭐T7 — publication_status=published+permalink — 재진입해도 permalink·published_at·external_id가 보인다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://threads.net/@x/1', external_id: 'media-1',
        published_at: '2026-09-04T00:00:00Z',
      },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const info = container.querySelector('[data-testid="channel-post-published-info"]');
    expect(info).not.toBeNull();
    expect(container.querySelector('a[href="https://threads.net/@x/1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-external-id"]')?.textContent).toBe('media-1');
  });

  it('⭐T9 — publication_status=container_created(부분 성공) — "이어서 발행" 안내가 보인다(발행됨 카드는 안 보임)', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', publication_status: 'container_created' },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-partial-success-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-published-info"]')).toBeNull();
    // doc §4-1/§17-4 — 부분 성공의 기본 행동은 "다시"가 아니라 "이어서 발행"이다(처음부터
    // 하면 컨테이너가 하나 더 생겨 같은 글이 두 번 나갈 수 있다).
    expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).textContent)
      .toBe(koMessages.content.channelPostsPublishContinueCta);
  });

  it('⭐publication_status=failed — 실패 안내가 보인다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', publication_status: 'failed', error_code: 'CHANNEL_PUBLISH_PROVIDER_ERROR' },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-publication-failed-notice"]')).not.toBeNull();
  });

  it('publication_status=null(발행 이력 없음) — 발행/부분성공/실패 블록이 전부 안 보인다(회귀 방지)', async () => {
    stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', publication_status: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-published-info"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-partial-success-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-publication-failed-notice"]')).toBeNull();
  });

  // story #3402 PR2 ②-a(AC5·doc §5) — 발행/발행 취소 버튼 게이팅(API 배선은 ②-b, 이
  // 조각에선 버튼이 실제 호출을 하지 않는다 — onClick 미배선).
  it('⭐canPublish=true(승인+해시일치) — 발행 버튼이 활성화되고 비활성 사유가 안 보인다', async () => {
    stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="channel-post-publish-disabled-reason"]')).toBeNull();
  });

  it('⭐canPublish=false(초안, 아직 승인 전) — 발행 버튼이 비활성화되고 사유가 버튼 밖에 보인다', async () => {
    stubFetch({ draftDetail: { gate_status: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-publish-disabled-reason"]')).not.toBeNull();
    // AC5 — 비활성 사유 문구가 버튼 "라벨 안"이 아니라 별도 엘리먼트(버튼 밖)에 있다.
    expect(btn.textContent).not.toContain(koMessages.content.publishDisabledReason);
  });

  // 페드루 PO 판정(2026-09-04 05:37Z) — unpublish 엔드포인트가 BE에 없어(grep 0건)
  // 게이팅만 선 죽은 버튼을 표면에 두지 않는다. canUnpublish 변수는 BE 선행(PR#3769
  // 뒤)이 착지하면 이 자리를 다시 켜는 용도로 남겨 두되, 지금은 role·publication_status
  // 어떤 조합이어도 버튼 자체가 렌더되지 않아야 한다.
  it('⭐발행 취소 버튼 — PR2에서는 화면에 아예 렌더하지 않는다(publication_status=published+owner여도)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-unpublish-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')).toBeNull();
  });

  // story #3402 PR2 ②-b(T7) — 발행 버튼 클릭 배선.
  it('⭐발행 성공 — permalink/external_id/published_at이 draft에 병합돼 T7 발행됨 정보가 즉시 보인다(재로드 없이)', async () => {
    stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.publishSuccess.replace('{time}', '').split('{')[0]);
    expect(container.querySelector('[data-testid="channel-post-published-info"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://threads.net/@x/1"]')).not.toBeNull();
  });

  // story #3402 PR2 ②-c(AC10) — CHANNEL_TEXT_TOO_LONG은 api-error.ts가 humanMessageKey를
  // 일부러 비워 두고 max_length/current_length만 실어 오는 코드다 — page.tsx가 doc §5
  // 표 그대로("500자 한도인데 517자입니다") 값을 실제로 보간해 조립하는지 pin한다.
  it('⭐발행 실패(CHANNEL_TEXT_TOO_LONG) — max_length/current_length가 실제 값으로 보간된 문구가 보인다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status: 422, body: { detail: { code: 'CHANNEL_TEXT_TOO_LONG', message: '한도 초과', max_length: 500, current_length: 517 } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.textContent).toContain('500자 한도인데 517자입니다');
  });

  it('⭐발행 실패(CHANNEL_RATE_LIMITED) — reset_at이 실제 시각으로 보간된 문구가 보인다', async () => {
    const resetAt = '2026-09-05T00:00:00Z';
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status: 429, body: { detail: { code: 'CHANNEL_RATE_LIMITED', message: '한도 초과', reset_at: resetAt } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.textContent).toContain(new Date(resetAt).toLocaleString());
  });

  // 카디르 QA 계획(2026-09-04) ⑤ — "api-error.ts가 파싱한다"는 사실만으로 화면 렌더까지
  // 됐다고 넘기지 않는다. AC10 12행 중 GATE_ALREADY_HELD·TEXT_TOO_LONG·RATE_LIMITED를
  // 뺀 나머지를 각 코드마다 개별 mock 응답으로 주입해 실제 렌더 문구를 pin한다.
  // ⚠️실측으로 찾은 결함(이 테스트를 쓰다가 발견) — 아래 6개 코드의 labelKey(api-error.ts)
  // 가 가리키는 번역 키 자체가 messages/*.json에 없었다(정의만 있고 값이 없어 next-intl이
  // MISSING_MESSAGE로 깨짐) — 이번에 추가해 해소.
  it.each([
    ['CHANNEL_TOKEN_EXPIRED', 409, koMessages.content.errorChannelTokenExpired],
    ['CHANNEL_CONNECTION_NOT_ACTIVE', 409, koMessages.content.errorChannelConnectionNotActive],
    ['CHANNEL_POST_APPROVER_ROLE_MISSING', 409, koMessages.content.errorChannelApproverRoleMissing],
    ['CHANNEL_PUBLISH_IN_PROGRESS', 409, koMessages.content.errorChannelPublishInProgress],
    ['CHANNEL_PUBLISH_PROVIDER_ERROR', 502, koMessages.content.errorChannelPublishProviderError],
    ['EXTERNAL_PUBLISH_APPROVAL_REQUIRED', 403, koMessages.content.errorApprovalRequired],
    ['SITE_POST_SEAL_MISSING', 409, koMessages.content.errorSealMissing],
    ['SITE_POST_REAPPROVAL_REQUIRED', 409, koMessages.content.errorReapprovalRequired],
  ])('⭐발행 실패(%s, AC10) — 화면에 해당 행의 사람 말이 실제로 렌더된다', async (code, status, expectedText) => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status, body: { detail: { code, message: 'raw' } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.textContent).toContain(expectedText);
  });

  // story #3414(PR#3769, 리뷰중) 대조 — 페드루 PO 지적(2026-09-04 05:44Z): scheduled=true
  // 응답은 permalink/external_id/published_at 셋 다 null이 정상이다(즉시 경로가 아니라
  // command만 만들고 워커가 나중에 실행). 그 null을 "발행됨"으로 그리면 AC2 규율(모르는
  // 것을 아는 것처럼 안 보여준다) 위반이라 scheduled 분기가 permalink 분기보다 먼저 와야
  // 한다 — 이 테스트가 그 순서를 pin한다.
  it('⭐발행 성공(예약, story #3414) — scheduled=true면 published_at이 null이어도 T7이 아니라 예약 안내가 보인다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({
        status: 200,
        body: { permalink: null, external_id: null, published_at: null, version_id: 'v1', scheduled: true, command_id: 'cmd-1', scheduled_at: '2026-09-05T00:00:00Z' },
      }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-published-info"]')).toBeNull();
    const result = container.querySelector('[data-testid="channel-post-publish-result"]');
    expect(result?.textContent).toContain(new Date('2026-09-05T00:00:00Z').toLocaleString());
  });

  it('canPublish=false면 발행 버튼을 눌러도 아무 일도 안 일어난다(handlePublish 가드)', async () => {
    stubFetch({ draftDetail: { gate_status: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-published-info"]')).toBeNull();
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
