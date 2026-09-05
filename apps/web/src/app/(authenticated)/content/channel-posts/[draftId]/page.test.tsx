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
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

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
  published_body_sha256: null as string | null,
  command_status: null as string | null,
  // B3(페드루 PO, 2026-09-04 13:14Z) — 실패 배지 mount에 쓰는 나머지 필드.
  command_reason_code: null as string | null,
  failure_kind: null as string | null,
  next_retry_at: null as string | null,
  processing_kind: null as string | null,
  // story f061c1a3 — 재시도 BFF가 붙일 대상 command.
  command_id: null as string | null,
  // story #3499(PO 確定 2026-09-05) — 최신 ChannelPublication.id. BE #3844 조각4
  // (미착지) 의존, 기본값 null(대부분 테스트가 이 스토리와 무관).
  publication_id: null as string | null,
  // story 15e481ce(#3453 AC2) — 이 채널 변형이 파생된 원문.
  source_content_item_id: null as string | null,
  // story #3457 후속(BE #3817 착지분) — 원문 제목 + staleness 판정용 버전 id 2종.
  source_title: null as string | null,
  source_site_post_version_id: null as string | null,
  source_current_site_post_version_id: null as string | null,
  // story #3453 AC3 후속(BE 판정 이관) — null=모른다(기본값).
  source_changed: null as boolean | null,
  // story #3514(lint-on-read, PO 確定 2026-09-05) — 단건 GET의 규칙 위반 목록.
  // 기본값 빈 배열(대부분 테스트가 이 스토리와 무관 — "위반 없음"이 기본).
  violations: [] as { code: string; field: string; value: string; hint_key: string; settings_path: string }[],
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
  // story #3500(BE #3498, 미착지) — 잔량 조회 응답(기본=정책 미설정)·false=502.
  genBudgetOk?: { limit_minor: number | null; spent_minor: number; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' } | false;
  draftDetail?: Partial<typeof DRAFT_DETAIL>;
  onSave?: (body: unknown) => { status: number; body: unknown };
  onSubmit?: (body: unknown) => { status: number; body: unknown };
  onPublish?: () => { status: number; body: unknown };
  onCancelScheduled?: () => { status: number; body: unknown };
  onUnpublish?: () => { status: number; body: unknown };
  // story #3402·PR#3764/#3767(페드루 PO 정정 2026-09-04 02:00Z) — GATE_ALREADY_HELD의
  // best-effort 상대 초안 조회. undefined=엔드포인트 자체가 404(구 계약, #3767 착지 전
  // 상황 재현) · { text_preview: null }=필드는 있는데 값이 없음 · 값 있으면 그 미리보기.
  holdingDraft?: { text_preview: string | null } | undefined;
  // story #3402(카디르 QA 2026-09-04) — AC2 "키 부재" 재현용. `draftDetail`은 DRAFT_DETAIL
  // 위에 스프레드 병합되므로 override 쪽에서 키를 빼도 base의 값이 살아남는다(고전
  // 함정) — 병합 "후"에 명시적으로 delete해야 진짜 키 부재를 재현한다.
  omitGateStatusKey?: boolean;
  // story #3426 — 연결의 회수 판정값. 기본값은 "회수 가능"(대부분 테스트가 게이팅 자체를
  // 안 다루므로 기본은 열려 있는 쪽이 자연스럽다) — 개별 테스트가 덮어써 막힌 경우를 본다.
  canUnpublish?: boolean;
  unpublishBlockedReason?: 'unsupported' | 'scope_insufficient' | null;
  // story #3458 — 연결 «상태»(토큰 등). 기본 'active'.
  connectionStatus?: 'active' | 'expired' | 'revoked' | 'error';
  connectionsOk?: boolean;
  // story #3428 — 이미지 규격(어댑터 성질). 기본값 0 = 이미지 미지원(기존 74건 전부가
  // 이 값을 몰라도 되므로 명시 안 하면 첨부 칸 자체가 안 뜨는 쪽이 자연스러운 기본).
  imageMaxCount?: number;
  onImageUploadUrl?: (body: unknown) => { status: number; body: unknown };
  onImagePut?: () => { status: number };
  onImageConfirm?: (body: unknown) => { status: number; body: unknown };
  // B2 테스트 전용 — PUT 응답을 이 promise가 풀릴 때까지 붙들어 'uploading' phase에
  // 머무는 순간을 관찰 가능하게 한다.
  imagePutGate?: Promise<void>;
  // B1(페드루 PO, 2026-09-04 13:26Z) — confirm 성공 뒤 단건 GET을 다시 부르는지, 그
  // 재조회가 서버 값(예: 재오픈된 gate_status)을 통째로 반영하는지 재현하는 스위치.
  // 지정하면 confirm 성공 이후의 단건 GET 응답이 이 값으로 바뀐다(그 前까지는 기본
  // draftDetail 그대로).
  draftAfterImageConfirm?: Record<string, unknown>;
  // story f061c1a3 — 재시도 BFF 응답+성공 뒤 단건 GET 재조회가 반영할 서버 값(보통
  // command_status='pending').
  onRetry?: (commandId: string) => { status: number; body?: unknown };
  draftAfterRetry?: Record<string, unknown>;
  // story #3499 — /publications/{id}/insights 응답. 넘기지 않으면(대부분 테스트가
  // publication_id 자체가 null이라 이 fetch를 아예 안 탄다) 빈 배열.
  insightSnapshots?: unknown[];
  // story #3517(Phase2·FE, BE #3865 조각①) — 댓글 목록 응답(옵션 생략=uncollected).
  commentsResponse?: {
    last_collected_at: string | null;
    comments: {
      id: string; external_comment_id: string; author_display_name: string | null; text: string;
      external_created_at: string | null; captured_at: string; deleted_at: string | null;
    }[];
    active_count: number;
    deleted_count: number;
  };
  commentsStatus?: number;
  onCommentsRefresh?: () => { status: number; body: unknown; headers?: Record<string, string> };
  // story #3519(§16-7 2부) — 이미지 confirm 성공 「직후」의 단건 GET 재조회(부수)만
  // 네트워크단 reject시킨다(격리 회귀가드).
  rejectDraftRefetchAfterImageConfirm?: boolean;
  // story #3517(BE #3867 조각②) — 댓글 「작업으로 전환」·「답변」 BFF 응답.
  onCommentFollowUp?: (body: unknown) => { status: number; body: unknown };
  onCommentReplyDraft?: (body: unknown) => { status: number; body: unknown };
  onCommentReplySubmit?: () => { status: number; body: unknown };
}) {
  const versions = opts.versions ?? [VERSION_1];
  const draftDetail: Record<string, unknown> = { ...DRAFT_DETAIL, ...opts.draftDetail };
  if (opts.omitGateStatusKey) delete draftDetail.gate_status;
  let currentDraftDetail = draftDetail;
  let rejectNextDraftRefetch = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}`) {
        // story #3519(§16-7 2부) — 이미지 업로드 confirm 성공 뒤 재조회(부수) 격리
        // 회귀가드용. rejectDraftRefetchAfterImageConfirm이 켜지면 confirm이 성공한
        // 「다음」 이 URL 호출(=재조회)만 네트워크단 reject한다(최초 페이지 로드
        // 호출은 그대로 성공).
        if (rejectNextDraftRefetch) { rejectNextDraftRefetch = false; throw new Error('network down'); }
        return { ok: true, status: 200, json: async () => ({ data: currentDraftDetail, error: null, meta: null }) };
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
        // 페드루 PO nit(2026-09-04 09:07Z) — 연결 조회 자체가 실패하면 unpublishGate가
        // undefined로 남는다("모른다") — 그 경로를 재현하는 스위치.
        if (opts.connectionsOk === false) return { ok: false, status: 500, json: async () => ({}) };
        // ⚠️`??`는 null도 nullish라 여기서 쓰면 "명시적으로 null을 넘긴" 테스트 케이스가
        // 조용히 500으로 되돌아간다 — 호출부가 필드 자체를 안 넘겼을 때만 500 기본값.
        const maxTextLength = 'maxTextLength' in opts ? opts.maxTextLength : 500;
        const accountLabel = 'accountLabel' in opts ? opts.accountLabel : 'Marketing Bot';
        const canUnpublish = opts.canUnpublish ?? true;
        const unpublishBlockedReason = opts.unpublishBlockedReason ?? null;
        // story #3458 — 연결 «상태»(토큰 등). 기본값 active(기존 테스트 전부가 "정상
        // 연결" 전제) — expired/revoked/error는 개별 테스트가 덮어쓴다.
        const connectionStatus = opts.connectionStatus ?? 'active';
        return {
          ok: true, status: 200,
          json: async () => ({
            data: [{
              id: 'c1', max_text_length: maxTextLength, account_label: accountLabel, account_id: 'acct-1',
              can_unpublish: canUnpublish, unpublish_blocked_reason: unpublishBlockedReason, status: connectionStatus,
              image_formats: ['image/jpeg', 'image/png'], image_max_bytes: 8 * 1024 * 1024,
              image_aspect_max: 10, image_width_min: 320, image_width_max: 1440,
              image_color_space: 'sRGB', image_max_count: opts.imageMaxCount ?? 0,
            }],
            error: null, meta: null,
          }),
        };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-connections/c1/publishing-limit`) {
        if (opts.limitOk === false) return { ok: false, status: 502, json: async () => ({}) };
        const limit = opts.limitOk ?? { quota_usage: 3, quota_total: 250 };
        return { ok: true, status: 200, json: async () => ({ data: limit, error: null, meta: null }) };
      }
      // story #3500(BE #3498, 미착지) — 잔량 조회. 기본값은 정책 미설정(null)이라
      // 대부분의 기존 테스트는 GenerationBudgetIndicator가 아무것도 안 그린다.
      if (url === `/api/organizations/${ORG_ID}/generation-budget`) {
        if (opts.genBudgetOk === false) return { ok: false, status: 502, json: async () => ({}) };
        const budget = opts.genBudgetOk
          ?? { limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' };
        return { ok: true, status: 200, json: async () => ({ data: budget, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/assets/upload-url` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts.onImageUploadUrl?.(body) ?? {
          status: 200,
          body: { upload_url: 'https://storage.example/put', object_path: 'channel-media/o/d1/x.jpg', expires_at: '2026-09-04T12:10:00Z', max_bytes: 26214400, required_put_headers: {} },
        };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === 'https://storage.example/put' && init?.method === 'PUT') {
        if (opts.imagePutGate) await opts.imagePutGate;
        const result = opts.onImagePut?.() ?? { status: 200 };
        return { ok: result.status < 400, status: result.status, json: async () => ({}) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/assets/confirm` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        const result = opts.onImageConfirm?.(body) ?? {
          status: 201,
          body: {
            draft_id: DRAFT_ID, version_id: 'v2', version: 2,
            original_width: 4000, original_height: 3000, original_bytes: 12000000,
            final_width: 1440, final_height: 1080, final_bytes: 3100000,
            was_converted: true, image_url: 'https://storage.googleapis.com/bucket/channel-media/o/d1/x.jpg',
          },
        };
        const ok = result.status < 400;
        if (ok) {
          if (opts.rejectDraftRefetchAfterImageConfirm) rejectNextDraftRefetch = true;
          // B1 — 실제 백엔드라면 confirm이 반영한 이미지 필드가 그다음 단건 GET에도
          // 그대로 실린다(같은 draft 행). 목(mock)도 그 사실을 반영해야 재조회 검증이
          // 뜻이 있다 — 그 위에 draftAfterImageConfirm(게이트 재오픈 등 이 조각이 별도로
          // 바꾸는 필드)을 덮어쓴다.
          const confirmed = result.body as {
            version?: number; image_url?: string | null; original_width?: number; original_bytes?: number;
            final_width?: number; final_bytes?: number; was_converted?: boolean;
          };
          currentDraftDetail = {
            ...currentDraftDetail,
            current_version: confirmed.version,
            thumbnail_url: confirmed.image_url,
            image_original_width: confirmed.original_width,
            image_original_bytes: confirmed.original_bytes,
            image_final_width: confirmed.final_width,
            image_final_bytes: confirmed.final_bytes,
            image_was_converted: confirmed.was_converted,
            ...opts.draftAfterImageConfirm,
          };
        }
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
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
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/cancel-scheduled` && init?.method === 'POST') {
        const result = opts.onCancelScheduled?.() ?? { status: 200, body: { command_id: 'cmd-1', status: 'cancelled', reason_code: null } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/unpublish` && init?.method === 'POST') {
        const result = opts.onUnpublish?.() ?? { status: 200, body: { publication_id: 'pub-1', status: 'unpublished', external_id: 'media-1', unpublished_at: '2026-09-04T00:00:00Z' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      const retryMatch = url.match(/\/channel-posts\/publication-commands\/([^/]+)\/retry$/);
      if (retryMatch && init?.method === 'POST') {
        const commandId = retryMatch[1] as string;
        const result = opts.onRetry?.(commandId) ?? { status: 200, body: { id: commandId, status: 'pending' } };
        const ok = result.status < 400;
        if (ok) currentDraftDetail = { ...currentDraftDetail, command_status: 'pending', ...opts.draftAfterRetry };
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/publications/`) && url.endsWith('/insights')) {
        return { ok: true, status: 200, json: async () => ({ data: opts.insightSnapshots ?? [], error: null, meta: null }) };
      }
      // story #3517(Phase2·FE, BE #3865 조각①) — 댓글 목록. 기본값(옵션 생략)은
      // last_collected_at=null(uncollected) — 대부분 테스트가 이 스토리와 무관.
      if (url.startsWith(`/api/organizations/${ORG_ID}/publications/`) && url.endsWith('/comments/refresh') && init?.method === 'POST') {
        const result = opts.onCommentsRefresh?.() ?? { status: 200, body: { fetched: 0, deleted: 0, captured_at: '2026-09-05T12:00:00Z' } };
        const ok = result.status < 400;
        const headers = new Map(Object.entries(result.headers ?? {}));
        return {
          ok, status: result.status,
          headers: { get: (name: string) => headers.get(name) ?? null },
          json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body),
        };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/publications/`) && url.endsWith('/comments')) {
        if (opts.commentsStatus && opts.commentsStatus >= 400) {
          return { ok: false, status: opts.commentsStatus, json: async () => ({ detail: 'boom' }) };
        }
        const data = opts.commentsResponse ?? { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 };
        return { ok: true, status: 200, json: async () => ({ data, error: null, meta: null }) };
      }
      // story #3517(BE #3867 조각②) — 댓글 「작업으로 전환」·「답변」.
      if (url.startsWith(`/api/organizations/${ORG_ID}/comments/`) && url.endsWith('/follow-ups') && init?.method === 'POST') {
        const parsedBody = JSON.parse(String(init.body ?? '{}'));
        const result = opts.onCommentFollowUp?.(parsedBody) ?? { status: 201, body: { story_id: 'story-1' } };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url.startsWith(`/api/organizations/${ORG_ID}/comments/`) && url.endsWith('/replies') && init?.method === 'POST') {
        const parsedBody = JSON.parse(String(init.body ?? '{}'));
        const result = opts.onCommentReplyDraft?.(parsedBody) ?? {
          status: 201,
          body: {
            id: 'reply-1', comment_id: 'c1', text: parsedBody.text, status: 'draft', gate_id: null,
            external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: null,
          },
        };
        const ok = result.status < 400;
        return { ok, status: result.status, json: async () => (ok ? { data: result.body, error: null, meta: null } : result.body) };
      }
      if (url.includes('/replies/') && url.endsWith('/submit') && init?.method === 'POST') {
        const result = opts.onCommentReplySubmit?.() ?? {
          status: 200,
          body: {
            id: 'reply-1', comment_id: 'c1', text: 'x', status: 'pending', gate_id: 'gate-1',
            external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: 'current',
          },
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

  // story #3422 ②-d(페드루 PO "지금 이 세션에서 조각 하나" 지시, 2026-09-04 11:49Z) —
  // 예약 상신 버튼 실배선.
  function setScheduleInput(value: string) {
    const input = document.body.querySelector('[data-testid="channel-post-schedule-at-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('⭐예약 상신 — 다이얼로그를 거쳐 미래 시각을 확認하면 submit 요청에 scheduled_at이 실린다', async () => {
    let submittedBody: unknown = null;
    stubFetch({ onSubmit: (body) => { submittedBody = body; return { status: 200, body: { gate_id: 'g1', version_id: 'v1', content_sha256: 'h1', status: 'pending' } }; } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const scheduleBtn = container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement;
    await act(async () => {
      scheduleBtn.click();
    });
    await flush();

    const futureLocal = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);
    await act(async () => {
      setScheduleInput(futureLocal);
    });
    const confirmBtn = document.body.querySelector('[data-testid="channel-post-schedule-at-confirm"]') as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    expect((submittedBody as { scheduled_at?: string } | null)?.scheduled_at).toBeTruthy();
    expect(container.textContent).toContain(koMessages.content.submitSuccess);
    // 성공하면 다이얼로그가 닫힌다.
    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-dialog"]')).toBeNull();
  });

  it('⭐예약 상신 — 서버가 scheduled_at pydantic 422를 반환하면 다이얼로그가 안 닫히고 사람 문장을 보인다', async () => {
    stubFetch({
      onSubmit: () => ({
        status: 422,
        body: { detail: [{ loc: ['body', 'scheduled_at'], msg: 'Value error, scheduled_at은 현재 시각 이후여야 합니다', type: 'value_error' }] },
      }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const scheduleBtn = container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement;
    await act(async () => {
      scheduleBtn.click();
    });
    await flush();

    const futureLocal = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);
    await act(async () => {
      setScheduleInput(futureLocal);
    });
    const confirmBtn = document.body.querySelector('[data-testid="channel-post-schedule-at-confirm"]') as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="channel-post-schedule-at-server-error"]')?.textContent)
      .toBe(koMessages.content.channelPostsScheduleAtServerErrorPastOrInvalid);
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

  // 페드루 PO 리뷰 nit(2026-09-04) — partialSuccess와 isRepublish가 동시에 참인 경우
  // (과거 발행 이력이 있는데 그 뒤 재승인된 새 버전을 다시 발행 시도했다가 부분 성공에
  // 걸린 것 — 둘 다 실제로 나올 수 있는 조합). 라벨 우선순위(partialSuccess가 이김)를 pin.
  // 이 테스트를 작성하다가 자체 발견 — published_body_sha256이 인터페이스엔 있었는데
  // view 계산에 실제로 안 넘어가고 있어(위 handlePublish 근처 수정 참고) isRepublish가
  // 이 화면에서 원래 절대 안 켜지고 있었다 — 그 자리를 이 테스트가 pin한다.
  it('⭐T9 우선순위 — partialSuccess&&isRepublish 둘 다 참이어도 "이어서 발행"이 이긴다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'new', body_sha256: 'new',
        published_body_sha256: 'old', published_at: '2026-09-01T00:00:00Z',
        publication_status: 'container_created',
      },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

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
  // story #3426(BE #3419 착지) — PR2에서 렌더 보류했던 회수 버튼을 복원. 기본 stubFetch는
  // canUnpublish=true·role='owner'라 활성 상태로 뜬다.
  it('⭐회수 버튼 — publication_status=published+owner+연결 can_unpublish=true면 활성화된다', async () => {
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
    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')).toBeNull();
  });

  // story #3458(유나 4회차 2차 발견) — 연결이 expired인데 can_unpublish=true(어댑터
  // 성질)만 보고 회수 버튼을 열어 누르면 401이 났다. connection.status도 같이 봐야 한다.
  it('⭐회수 버튼 — 연결이 expired면 can_unpublish=true여도 비활성 + 사유(연결 화면 링크 포함)가 뜬다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      connectionStatus: 'expired',
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    const reason = container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]');
    expect(reason?.textContent).toBe(koMessages.content.channelPostsUnpublishConnectionNotActive.replace(/<\/?link>/g, ''));
    expect(reason?.querySelector('a')?.getAttribute('href')).toBe('/organization/channels');
  });

  it('회수 버튼 — 연결이 active면(기본값) 사유가 안 뜨고 활성 상태를 유지한다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      connectionStatus: 'active',
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')).toBeNull();
  });

  it('⭐회수 버튼 — publication_status가 published가 아니면 렌더되지 않는다', async () => {
    stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', publication_status: null } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-unpublish-button"]')).toBeNull();
  });

  // 페드루 PO nit(2026-09-04 09:07Z) — 연결 조회 실패로 unpublishGate가 "모른다"(undefined)
  // 로 남으면 버튼은 비활성인데 사유가 없었다(AC1 "사유는 버튼 밖" 위반). role은 owner라
  // 통과했지만 연결 판정 자체를 못 받아 그 사유가 떠야 한다.
  it('⭐회수 버튼 — 연결 조회 실패(unpublishGate=모른다)면 비활성화되고 "확認하지 못했습니다" 사유가 보인다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      connectionsOk: false,
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsUnpublishGateUnknown);
  });

  it('⭐회수 버튼 — role=member면 비활성화되고 owner/admin 전용 사유가 보인다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'member' });
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
    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsCancelUnpublishOwnerOrAdminOnly);
  });

  it('⭐회수 버튼 — unpublish_blocked_reason=unsupported면 버튼도 사유도 렌더되지 않는다(§17-11 대상 아님)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      canUnpublish: false, unpublishBlockedReason: 'unsupported',
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-unpublish-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')).toBeNull();
  });

  it('⭐회수 버튼 — unpublish_blocked_reason=scope_insufficient+owner면 "연결을 다시 하면" 문구가 보인다(doc §17-11 정본)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      canUnpublish: false, unpublishBlockedReason: 'scope_insufficient',
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const btn = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // story #3458 — owner 문구엔 이제 /organization/channels 인라인 링크가 있다(태그는
    // 렌더된 textContent에 안 남는다).
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsUnpublishScopeInsufficientOwner.replace(/<\/?link>/g, ''));
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.getAttribute('data-unpublish-reason'))
      .toBe('scope_insufficient');
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"] a')?.getAttribute('href'))
      .toBe('/organization/channels');
  });

  // 카디르 QA 지적(2026-09-04 09:02Z) — 이전 판 테스트명이 단언과 반대였다("member면
  // owner에게 요청 문구"라 적었지만 실제 단언은 OwnerOrAdminOnly). member는 owner/admin
  // 게이팅이 scope_insufficient보다 먼저 걸려 §17-11 role 문구 자체가 안 뜬다 — 이름을
  // 실제 동작대로 정정한다.
  it('⭐회수 버튼 — unpublish_blocked_reason=scope_insufficient+member면 role 게이팅이 먼저 걸려 owner/admin 전용 사유가 보인다(§17-11 role분기 문구 자체는 안 뜸)', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'member' });
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      canUnpublish: false, unpublishBlockedReason: 'scope_insufficient',
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsCancelUnpublishOwnerOrAdminOnly);
  });

  // 카디르 QA 지적 — §17-11 role 분기 문구가 실제로 렌더되는 경로(role=owner/admin이면서
  // scope_insufficient)가 테스트 0건이었다. admin으로 그 실렌더 경로를 pin한다.
  it('⭐회수 버튼 — unpublish_blocked_reason=scope_insufficient+admin이면(role게이팅 통과) "요청" 문구가 실제로 렌더된다(doc §17-11 정본, non-owner 분기)', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'admin' });
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      canUnpublish: false, unpublishBlockedReason: 'scope_insufficient',
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    // admin은 canUnpublish(role게이팅)를 통과하므로 §17-11 role분기 문구가 실제로 뜬다 —
    // role==='owner'가 아니므로 member쪽 문구(요청)가 나온다(admin도 재연결 owner전용이라
    // "요청" 갈래 — 페이지 코드가 role==='owner'만 owner문구, 그 외 전부 요청문구).
    expect(container.querySelector('[data-testid="channel-post-unpublish-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsUnpublishScopeInsufficientNonOwner);
  });

  // story #3426 — 예약 취소 버튼.
  it('⭐예약 취소 버튼 — command_status=pending이면 활성화된다(owner)', async () => {
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const btn = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it.each(['blocked', 'dead_letter'])('⭐예약 취소 버튼 — command_status=%s도 렌더된다', async (status) => {
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: status } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]')).not.toBeNull();
  });

  it.each(['completed', 'cancelled', 'voided', 'in_progress'])('⭐예약 취소 버튼 — command_status=%s면 렌더되지 않는다(이미 나갔거나 끝난 것)', async (status) => {
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: status } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]')).toBeNull();
  });

  it('⭐예약 취소 버튼 — role=member면 비활성화되고 owner/admin 전용 사유가 보인다', async () => {
    useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [], role: 'member' });
    stubFetch({ draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' } });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const btn = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-cancel-scheduled-disabled-reason"]')?.textContent)
      .toBe(koMessages.content.channelPostsCancelUnpublishOwnerOrAdminOnly);
  });

  // story #3426 ①-c — 예약 취소 클릭→ConfirmDialog→성공, 리로드 없이 command_status 갱신.
  it('⭐예약 취소 — 확認 다이얼로그를 거쳐 성공하면 리로드 없이 취소 버튼이 사라진다', async () => {
    let cancelCalled = false;
    stubFetch({
      draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' },
      onCancelScheduled: () => { cancelCalled = true; return { status: 200, body: { command_id: 'cmd-1', status: 'cancelled', reason_code: null } }; },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // ConfirmDialog는 Portal이라 document.body에 뜬다(content/[draftId]/page.test.tsx와 동형).
    // 카디르 QA①·유나 §8 — "무엇이 멈추나"·"되돌릴 수 있나"가 서로 다른 노드인지 확인.
    const what = document.body.querySelector('[data-testid="channel-post-cancel-scheduled-confirm-what"]');
    const reversible = document.body.querySelector('[data-testid="channel-post-cancel-scheduled-confirm-reversible"]');
    expect(what?.textContent).toBe(koMessages.content.channelPostsCancelScheduledConfirmWhat);
    expect(reversible?.textContent).toBe(koMessages.content.channelPostsCancelScheduledConfirmReversible);
    expect(what).not.toBe(reversible);
    expect(document.body.querySelectorAll('p p').length).toBe(0);

    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsCancelScheduledConfirmAction);
    expect(confirmButton).not.toBeUndefined();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(cancelCalled).toBe(true);
    expect(container.textContent).toContain(koMessages.content.channelPostsCancelScheduledSuccess);
    // 리로드 없이 로컬 갱신 — command_status가 더 이상 취소가능 값이 아니므로 버튼이 사라진다.
    expect(container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]')).toBeNull();
    // 페드루 PO 블로커 — 배너뿐 아니라 §17-10 "취소됨" 오버레이도 리로드 없이 선다.
    expect(container.querySelector('[data-testid="channel-post-cancelled-notice"]')?.textContent)
      .toBe(koMessages.content.channelPostsCancelledNotice);
  });

  // story #3426 ①-d — PUBLICATION_COMMAND_NOT_CANCELLABLE은 current_status를 실어
  // "이미 {status} 상태입니다"를 조립한다(labelKey 비움, TEXT_TOO_LONG과 같은 패턴).
  it('⭐예약 취소 실패(409 PUBLICATION_COMMAND_NOT_CANCELLABLE) — current_status가 보간된 조립 문구가 보이고 버튼은 그대로 남는다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' },
      onCancelScheduled: () => ({ status: 409, body: { detail: { code: 'PUBLICATION_COMMAND_NOT_CANCELLABLE', message: '이미 실행 중입니다', current_status: 'in_progress' } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsCancelScheduledConfirmAction);
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('이미 in_progress 상태라 취소할 수 없습니다');
    expect(container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]')).not.toBeNull();
  });

  // story #3426 ①-c — 회수 클릭→ConfirmDialog→성공(리로드 없이 배너만, chip 갱신은 별도 설계 이슈로 명시 보류).
  it('⭐회수 — 확認 다이얼로그를 거쳐 성공하면 회수 완료 배너가 보인다', async () => {
    let unpublishCalled = false;
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      onUnpublish: () => { unpublishCalled = true; return { status: 200, body: { publication_id: 'pub-1', status: 'unpublished', external_id: 'media-1', unpublished_at: '2026-09-04T01:00:00Z' } }; },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    // 카디르 QA①·유나 §8 — 회수도 "무엇이 멈추나"·"되돌릴 수 있나" 별도 노드 확인.
    const what = document.body.querySelector('[data-testid="channel-post-unpublish-confirm-what"]');
    const reversible = document.body.querySelector('[data-testid="channel-post-unpublish-confirm-reversible"]');
    expect(what?.textContent).toBe(koMessages.content.channelPostsUnpublishConfirmWhat);
    expect(reversible?.textContent).toBe(koMessages.content.channelPostsUnpublishConfirmReversible);
    expect(what).not.toBe(reversible);

    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsUnpublishConfirmAction);
    expect(confirmButton).not.toBeUndefined();
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(unpublishCalled).toBe(true);
    expect(container.textContent).toContain(koMessages.content.channelPostsUnpublishSuccess);
    // 페드루 PO 정정(2026-09-04 08:40Z) — 회수 뒤 로컬 상태를 서버가 다음 로드에서 줄 값과
    // 같은 모양으로 맞춘다: publication_status='unpublished'·published_at=null·permalink=null.
    // 리로드 없이 「회수됨」 오버레이가 뜨고, 발행됨 정보 카드·회수 버튼은 사라진다.
    expect(container.querySelector('[data-testid="channel-post-unpublished-notice"]')?.textContent)
      .toBe(koMessages.content.channelPostsUnpublishedNotice);
    expect(container.querySelector('[data-testid="channel-post-published-info"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-unpublish-button"]')).toBeNull();
  });

  // 페드루 PO nit(2026-09-04 09:07Z) — 이전 판 테스트명이 "서버 문구가 보인다"였지만
  // 실제로는 서버 원문이 아니라 §17-11 FE 정본 문구가 뜬다(role='owner' 분기) — 이름 정정.
  it('⭐회수 실패(422 CHANNEL_SCOPE_INSUFFICIENT) — 서버 원문 대신 §17-11 FE 정본 문구(owner 분기)가 보인다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      onUnpublish: () => ({ status: 422, body: { detail: { code: 'CHANNEL_SCOPE_INSUFFICIENT', message: '스코프가 부족합니다', required_scopes: ['threads_delete'] } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsUnpublishConfirmAction);
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // story #3426 ①-d(doc §17-11) — CHANNEL_SCOPE_INSUFFICIENT는 서버 원문이 아니라
    // §17-11 role 분기 정본 문구를 그대로 재사용한다(role='owner' 기본).
    // story #3458 — 이 결과 배너는 plain string(unpublishResult.text)이라 <link> 태그를
    // 벗겨서 쓴다(버튼 밖 사유줄만 t.rich로 실 링크).
    expect(container.textContent).toContain(koMessages.content.channelPostsUnpublishScopeInsufficientOwner.replace(/<\/?link>/g, ''));
  });

  // story #3426 ①-d(카디르 QA 계획 ⑤ 선례) — "api-error.ts가 파싱한다"는 사실만으로 화면
  // 렌더까지 됐다고 넘기지 않는다. 나머지 신규 코드도 개별 mock으로 실제 렌더 문구를 pin.
  it('⭐예약 취소 실패(404 PUBLICATION_COMMAND_NOT_FOUND) — 화면에 사람 말이 실제로 렌더된다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' },
      onCancelScheduled: () => ({ status: 404, body: { detail: { code: 'PUBLICATION_COMMAND_NOT_FOUND' } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const trigger = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsCancelScheduledConfirmAction);
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain(koMessages.content.errorPublicationCommandNotFound);
  });

  it.each([
    ['CHANNEL_POST_NOT_PUBLISHED', 409, 'errorChannelPostNotPublished'],
    ['CHANNEL_UNPUBLISH_UNSUPPORTED', 422, 'errorChannelUnpublishUnsupported'],
  ] as const)('⭐회수 실패(%s) — 화면에 사람 말이 실제로 렌더된다', async (code, status, key) => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      onUnpublish: () => ({ status, body: { detail: { code } } }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();
    const trigger = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsUnpublishConfirmAction);
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain(koMessages.content[key]);
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

    // story 3436(묶음 5 확장, PO 지적) — §11-2 정본 형식(formatScheduledAt)으로 pin 이동
    // (toLocaleString()은 브라우저 로케일 의존이라 이 화면의 다른 시각 표기와도 어긋났다).
    expect(container.textContent).toContain(formatScheduledAt(resetAt, resolveDisplayTimezone().tz).display);
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
    // story 3436(묶음 5 확장) — §11-2 정본 형식으로 pin 이동(회귀 아님).
    expect(result?.textContent).toContain(formatScheduledAt('2026-09-05T00:00:00Z', resolveDisplayTimezone().tz).display);
  });

  // 디디군 리뷰 nit(2026-09-04 06:05Z, PR#3769 진행 중 발견) — 재발행 요청이 이번엔
  // scheduled=true로 응답(permalink/external_id/published_at 셋 다 null)해도, 이미 예전에
  // 발행돼 draft에 남아있던 published_at·permalink를 지우면 안 된다. handlePublish의
  // scheduled 분기가 permalink 존재 분기보다 먼저라 setDraft 병합 자체를 안 타는 것으로
  // 이미 해소돼 있음 — 이 테스트가 그 사실을 pin한다.
  it('⭐scheduled=true 응답이 기존 발행됨 정보(published_at 등)를 지우지 않는다(디디군 리뷰 대조)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://old-permalink', published_at: '2026-09-01T00:00:00Z', external_id: 'old-id',
      },
      onPublish: () => ({
        status: 200,
        body: { permalink: null, external_id: null, published_at: null, version_id: 'v2', scheduled: true, command_id: 'cmd-1', scheduled_at: '2026-09-05T00:00:00Z' },
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

    const info = container.querySelector('[data-testid="channel-post-published-info"]');
    expect(info?.textContent).toContain('old-permalink');
    expect(container.querySelector('a[href="https://old-permalink"]')).not.toBeNull();
  });

  // story #3402 AC11(doc §5-1) — "왜 막혔나"(reason)와 "밖으로 나갔나"(externalImpact)는
  // 서로 다른 텍스트 노드로 각각 존재해야 한다(카디르 QA 계획 ④ — 겹치는 단어로 한 문장에
  // 뭉쳐 정규식 하나로 통과하는 함정 방지).
  it('⭐AC11 — 4xx로 막힌 실패(예: CONNECTION_NOT_ACTIVE)는 "Threads에 아무것도 보내지 않았다"가 별도 노드로 보인다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status: 409, body: { detail: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE' } } }),
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

    const reason = container.querySelector('[data-testid="channel-post-publish-error-reason"]');
    const impact = container.querySelector('[data-testid="channel-post-publish-external-impact"]');
    expect(reason?.textContent).toBe(koMessages.content.errorChannelConnectionNotActive);
    expect(impact?.textContent).toBe(koMessages.content.channelPostsExternalImpactNotSent);
    // 두 문장이 진짜 별개 DOM 노드인지(하나로 뭉쳐 겹치는 키워드만 있는 게 아닌지) 확인.
    expect(reason).not.toBe(impact);
    // 카디르 QA 실결함(2026-09-04) — 이 블록의 부모가 AlertDescription(=<p>)이다. <p> 안에
    // <p>를 또 두면 HTML 무효+Next hydration 에러가 실제로 났다(jsdom 테스트는 관대해서
    // DOM은 만들어 주지만 실브라우저/hydration은 안 봐준다) — 구조 자체를 assert한다.
    expect(container.querySelectorAll('p p').length).toBe(0);
    expect(reason?.tagName).not.toBe('P');
    expect(impact?.tagName).not.toBe('P');
  });

  it('⭐AC11 — 502(PROVIDER_ERROR)는 "요청은 나갔다" 별도 안내가 보인다(4xx와 다른 문구)', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status: 502, body: { detail: { code: 'CHANNEL_PUBLISH_PROVIDER_ERROR' } } }),
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

    expect(container.querySelector('[data-testid="channel-post-publish-external-impact"]')?.textContent)
      .toBe(koMessages.content.channelPostsExternalImpactReachedProvider);
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

  // story f30da19a AC5 — T3(상세 머리).
  it('⭐AC5 — channel=sandbox면 상세 머리에 「테스트」 배지가 뜬다', async () => {
    stubFetch({ draftDetail: { channel: 'sandbox' } });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')?.textContent)
      .toBe(koMessages.content.channelPostsSandboxTestBadge);
  });

  it('AC5 — channel=threads(실채널)면 배지가 없다', async () => {
    stubFetch({});
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')).toBeNull();
  });

  // B3(페드루 PO, 2026-09-04 13:14Z) — FailureActionBadge가 정의만 있고 이 화면엔
  // mount 안 돼 있던 갭(#3422 AC3). 표본 5종이 상세에서 실제로 「보인다」를 pin한다.
  describe('⭐B3 — 실패 배지 5종이 상세에서 보인다', () => {
    it('blocked', async () => {
      stubFetch({ draftDetail: { command_status: 'blocked' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureBlocked);
    });

    it('needs_check', async () => {
      stubFetch({ draftDetail: { command_status: 'pending', failure_kind: 'needs_check' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureCheckedRetryCta);
    });

    it('auto_retry', async () => {
      stubFetch({
        draftDetail: { command_status: 'pending', failure_kind: 'transient', next_retry_at: '2026-09-05T00:00:00Z' },
      });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    });

    it('dead_letter', async () => {
      stubFetch({ draftDetail: { command_status: 'dead_letter' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureRetryCta);
    });

    it('voided', async () => {
      stubFetch({ draftDetail: { command_status: 'voided', command_reason_code: 'CONTENT_CHANGED' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureVoidedWithReason.replace('{reason}', '본문이 바뀜'));
    });
  });

  // story f061c1a3(#3422 AC3 잔여) — 실패 배지 「재시도」 클릭 배선. ConfirmDialog는
  // Portal이라 document.body에 뜬다(cancel-scheduled·unpublish 다이얼로그 테스트와 동형).
  describe('⭐f061c1a3 — 재시도 클릭 배선(dead_letter 확認 다이얼로그·needs_check 2단계)', () => {
    it('⭐AC1 — dead_letter 재시도 버튼 클릭 → 다이얼로그 열림(무엇이·되돌릴 수 있나) → 취소는 호출 0', async () => {
      let retryCalled = 0;
      stubFetch({ draftDetail: { command_status: 'dead_letter', command_id: 'cmd-1' }, onRetry: () => { retryCalled++; return { status: 200 }; } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
      expect(retryBtn.disabled).toBe(false);
      await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(document.body.querySelector('[data-testid="channel-post-retry-confirm-what"]')?.textContent)
        .toBe(koMessages.content.channelPostsRetryConfirmWhatDeadLetter);
      expect(document.body.querySelector('[data-testid="channel-post-retry-confirm-reversible"]')?.textContent)
        .toBe(koMessages.content.channelPostsRetryConfirmReversible);
      // dead_letter는 체크리스트가 없다(needs_check 전용).
      expect(document.body.querySelector('[data-testid="channel-post-retry-confirm-checklist"]')).toBeNull();

      const cancelBtn = [...document.body.querySelectorAll('button')].filter((b) => b !== retryBtn).find((b) => b.textContent === koMessages.content.channelPostsRetryConfirmCancel);
      await act(async () => { cancelBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(retryCalled).toBe(0);
    });

    it('⭐AC1 — dead_letter 확認 시 BFF POST(commandId 그대로) 1회 → 성공 뒤 서버 상태로 배지 갱신(재조회)', async () => {
      let retryCalled = 0;
      stubFetch({
        draftDetail: { command_status: 'dead_letter', command_id: 'cmd-1' },
        onRetry: (commandId) => { retryCalled++; expect(commandId).toBe('cmd-1'); return { status: 200, body: { id: 'cmd-1', status: 'pending' } }; },
      });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
      await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();
      const confirmBtn = [...document.body.querySelectorAll('button')].filter((b) => b !== retryBtn).find((b) => b.textContent === koMessages.content.channelPostsRetryConfirmAction);
      await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(retryCalled).toBe(1);
      expect(container.querySelector('[data-testid="channel-post-retry-result"]')?.textContent).toBe(koMessages.content.channelPostsRetrySuccess);
      // 서버가 pending으로 돌렸고 failure_kind는 null(백엔드 retry_dead_letter_command가
      // 지운다) — deriveFailureAction이 undefined를 내 배지 자체가 사라진다.
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
    });

    it('AC1 — 403(HUMAN_ONLY)은 서버 문장을 그대로 보인다(삼키지 않음)', async () => {
      stubFetch({
        draftDetail: { command_status: 'dead_letter', command_id: 'cmd-1' },
        onRetry: () => ({ status: 403, body: { detail: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', message: '채널 포스트 발행은 휴먼 멤버만 가능합니다(에이전트는 초안·상신까지).' } } }),
      });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
      await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();
      const confirmBtn = [...document.body.querySelectorAll('button')].filter((b) => b !== retryBtn).find((b) => b.textContent === koMessages.content.channelPostsRetryConfirmAction);
      await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      // story #3454 — raw 토글이 이제 같은 Alert 안에 형제로 붙어 textContent가 늘었다
      // (AlertDescription 자체를 짚어 사람 문장만 본다, 토글 텍스트와 안 섞는다).
      expect(container.querySelector('[data-testid="channel-post-retry-result"] p')?.textContent)
        .toBe(koMessages.content.errorChannelPublishHumanOnly);
    });

    // AC2 — needs_check 2단계: 체크 前 확認 버튼 비활성, 체크 後 활성.
    it('⭐AC2 — needs_check는 체크리스트가 뜨고, 체크 前엔 다이얼로그 확認 버튼이 비활성이다', async () => {
      stubFetch({ draftDetail: { command_status: 'pending', failure_kind: 'needs_check', command_id: 'cmd-2' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
      await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      const checklist = document.body.querySelector('[data-testid="channel-post-retry-confirm-checklist"]') as HTMLInputElement;
      expect(checklist).not.toBeNull();
      const confirmBtn = [...document.body.querySelectorAll('button')].filter((b) => b !== retryBtn).find((b) => b.textContent === koMessages.content.channelPostsRetryConfirmAction) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);

      await act(async () => { checklist.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(confirmBtn.disabled).toBe(false);
    });

    it('AC2 — needs_check 확認 문구는 dead_letter와 다르다', async () => {
      stubFetch({ draftDetail: { command_status: 'pending', failure_kind: 'needs_check', command_id: 'cmd-2' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
      await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();
      expect(document.body.querySelector('[data-testid="channel-post-retry-confirm-what"]')?.textContent)
        .toBe(koMessages.content.channelPostsRetryConfirmWhatNeedsCheck);
    });
  });

  // B4(페드루 PO, 2026-09-04 13:26Z) — command_status가 pending/blocked면 새 발행·예약
  // 상신을 막는다(이미 진행 중이거나 고쳐야 할 게 따로 있음). dead_letter는 예외
  // (f061c1a3 前까지 발행이 유일한 수동 재시도 경로) — 아래에서 활성 그대로임을 pin한다.
  describe('⭐B4 — command_status가 pending/blocked면 발행·예약 상신을 막는다(dead_letter는 예외)', () => {
    it('pending — 발행·예약 상신 버튼이 비활성화되고 pending 전용 사유가 버튼 밖에 보인다', async () => {
      stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', command_status: 'pending' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
      expect(container.querySelector('[data-testid="channel-post-command-inflight-reason"]')?.textContent)
        .toBe(koMessages.content.channelPostsCommandInFlightReasonPending);
      expect(container.querySelector('[data-testid="channel-post-schedule-submit-command-inflight-reason"]')?.textContent)
        .toBe(koMessages.content.channelPostsCommandInFlightReasonPending);
    });

    // 유나 재판정(2026-09-04 13:37Z) — pending·blocked를 한 문장에 묶으면 절반은 틀린
    // 지시가 된다. blocked 전용 문구("연결 문제")가 pending 전용 문구("예약/재시도")와
    // 다른 것을 pin한다.
    it('blocked — 발행·예약 상신 버튼이 비활성화되고 blocked 전용 사유가 pending과 다르다', async () => {
      stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', command_status: 'blocked' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
      // story #3458 — 이 문구엔 이제 /organization/channels 인라인 링크(<link>...</link>)가
      // 있다. 렌더된 textContent엔 태그가 안 남으므로 비교 원문에서도 태그만 벗겨 낸다.
      expect(container.querySelector('[data-testid="channel-post-command-inflight-reason"]')?.textContent)
        .toBe(koMessages.content.channelPostsCommandInFlightReasonBlocked.replace(/<\/?link>/g, ''));
      expect(container.querySelector('[data-testid="channel-post-command-inflight-reason"]')?.textContent)
        .not.toBe(koMessages.content.channelPostsCommandInFlightReasonPending);
      const link = container.querySelector('[data-testid="channel-post-command-inflight-reason"] a');
      expect(link?.getAttribute('href')).toBe('/organization/channels');
    });

    // 페드루 PO 실물 확認(2026-09-04 17:22Z) — 이미 발행된 글의 회수(unpublish) 명령이
    // 만료 토큰으로 blocked면 canPublish(=view.publishable)가 false다(재발행 대상이
    // 아니므로). 이전 코드는 이 사유줄을 canPublish에 매달아 이 조합에서 "연결 화면"
    // 링크가 화면 어디에도 안 남았다 — blocked는 canPublish와 무관하게 뜬다.
    it('⭐발행 済 + command_status=blocked(unpublish 명령) — canPublish=false여도 링크 사유줄이 뜬다', async () => {
      stubFetch({
        draftDetail: {
          gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
          publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
          command_status: 'blocked',
        },
      });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(true);
      const reason = container.querySelector('[data-testid="channel-post-command-inflight-reason"]');
      expect(reason).not.toBeNull();
      expect(reason?.querySelector('a')?.getAttribute('href')).toBe('/organization/channels');
    });

    it('dead_letter — 예외라 발행 버튼이 그대로 활성(f061c1a3 前까지 유일한 재시도 경로)', async () => {
      stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', command_status: 'dead_letter' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(false);
      expect(container.querySelector('[data-testid="channel-post-command-inflight-reason"]')).toBeNull();
    });

    it('즉시 상신 버튼은 이 게이팅 밖(PO 지시가 발행·예약 상신 둘로 명시)', async () => {
      stubFetch({ draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1', command_status: 'pending' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('canPublish=false면 command_status와 무관하게 원래 사유(게이트 문제)만 보인다', async () => {
      stubFetch({ draftDetail: { gate_status: null, command_status: 'pending' } });
      await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="channel-post-publish-disabled-reason"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="channel-post-command-inflight-reason"]')).toBeNull();
    });
  });
});

// story #3428(T3-M·§17-16) — 이미지 첨부 UI.
describe('ChannelPostEditPage — 이미지 첨부(T3-M, story #3428)', () => {
  it('⭐§17-16 — image_max_count=0(또는 미지원)이면 첨부 칸 자체를 그리지 않는다', async () => {
    stubFetch({ imageMaxCount: 0 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-image-attach"]')).toBeNull();
  });

  it('⭐AC1 — image_max_count=1이면 첨부 칸이 뜨고 규격 태그가 어댑터 선언값 그대로 보인다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-image-attach"]')).not.toBeNull();
    const specTag = container.querySelector('[data-testid="channel-post-image-spec-tag"]')?.textContent ?? '';
    expect(specTag).toContain('JPEG, PNG');
    // N(페드루 PO, 2026-09-04 13:27Z) — formatFileSize(재구현 금지 헬퍼 재사용, 자동
    // 단위)로 교체 — "8.0MB"(공백 없음)가 아니라 "8.0 MB".
    expect(specTag).toContain('8.0 MB');
    expect(specTag).toContain('10:1');
    expect(specTag).toContain('320');
    expect(specTag).toContain('1440');
    // N — image_color_space가 imageSpec까지만 오고 화면엔 한 번도 안 실렸던 갭.
    expect(specTag).toContain('sRGB');
  });

  it('⭐업로드 성공 — 발급→PUT→confirm 3단계를 순서대로 거쳐 썸네일이 뜬다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-image-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-image-upload-error"]')).toBeNull();
  });

  // story #3519(§16-7 2부, PO 確定 2026-09-05) — confirm 성공 뒤 재조회(draft/versions
  // 단건 GET, 부수)가 격리 없이 Promise.all에 있어, 재조회 쪽이 네트워크단 reject하면
  // 바깥 catch가 "이미지 업로드 실패"로 오문구를 냈다 — 업로드 자체(confirm까지)는 이미
  // 성공했는데 사용자는 업로드가 실패한 걸로 오인한다.
  it('⭐#3519 — confirm 성공 뒤 재조회가 네트워크 reject해도 "업로드 실패" 오문구가 안 뜬다', async () => {
    stubFetch({ imageMaxCount: 1, rejectDraftRefetchAfterImageConfirm: true });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-image-upload-error"]')).toBeNull();
  });

  // B1(페드루 PO, 2026-09-04 13:26Z) — confirm이 새 버전을 만들며 서버가 approved
  // 게이트를 재오픈+reapproval_required=true로 바꿀 수 있다. 이미지 필드만 로컬 병합하면
  // 이 갱신을 놓친다 — 단건 GET을 다시 불러 gate_status/reapproval_required까지 서버
  // 값으로 통째 교체되는 것을 pin한다.
  it('⭐B1 — confirm 성공 뒤 단건 GET을 재조회해 gate_status·reapproval_required까지 서버 값으로 갱신된다', async () => {
    stubFetch({
      imageMaxCount: 1,
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      // confirm이 게이트를 재오픈한 뒤의 서버 진실.
      draftAfterImageConfirm: { gate_status: 'pending', reapproval_required: true },
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    // 업로드 전 — 승인됨이라 발행 버튼이 활성.
    expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(false);

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // 이미지 필드(썸네일)도 여전히 반영되고, 게이트가 재오픈됐다는 서버 진실까지
    // 같이 들어와 발행 버튼이 다시 막힌다(이미지 필드만 로컬 병합했다면 여전히 활성).
    expect(container.querySelector('[data-testid="channel-post-image-preview"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement).disabled).toBe(true);
  });

  // B2(페드루 PO, 2026-09-04 13:27Z·code-review 지적) — 이미지 업로드가 진행 중인 동안
  // 저장/즉시 상신/예약 상신 버튼이 막히는지(서로 다른 흐름이 각자 새 버전을 만들어
  // 경합하는 것을 방지). PUT 응답을 gate로 붙들어 'uploading' phase에 실제로 머무는
  // 순간을 관찰한다.
  it('⭐B2 — 이미지 업로드 진행 중(uploading)엔 저장·상신·예약 상신 버튼이 모두 비활성화되고, 끝나면 풀린다', async () => {
    let releaseUpload: (() => void) | undefined;
    const imagePutGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    stubFetch({ imageMaxCount: 1, imagePutGate });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // requesting_url→uploading으로 넘어갈 만큼만 마이크로태스크를 흘려보낸다(PUT은
      // imagePutGate가 안 풀려 여기서 멈춰 있다).
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="channel-post-image-upload-progress"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-image-upload-in-progress-reason"]')).not.toBeNull();

    await act(async () => {
      releaseUpload?.();
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-image-upload-progress"]')).toBeNull();
    expect((container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(false);
  });

  // B3(페드루 PO·유나 지적, 2026-09-04) — 첨부 칸은 실제로 파일 1개만 받는데
  // "{count}장까지"라고 적으면 화면이 안 하는 일을 약속하는 거짓 라벨이 된다.
  it('⭐B3 — 첨부 칸 라벨이 개수를 약속하지 않는다("장까지" 문구 없음)', async () => {
    stubFetch({ imageMaxCount: 4 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const attach = container.querySelector('[data-testid="channel-post-image-attach"]');
    expect(attach?.textContent).not.toContain('장까지');
    expect(attach?.textContent).toContain(koMessages.content.channelPostsImageAttachLabel);
  });

  // ②(유나 지적, 2026-09-04) — <input type=file>는 접근 가능한 이름이 없고 브라우저
  // 기본 컨트롤 라벨이 로케일을 안 따른다. 화면엔 라벨 붙은 Button만 노출되고, input은
  // hidden이라 접근성 트리 밖에 있어야 한다.
  it('⭐②-a — 파일 입력은 hidden이고, 라벨 붙은 Button이 대신 트리거한다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    expect(input.hidden).toBe(true);
    const trigger = container.querySelector('[data-testid="channel-post-image-attach-trigger"]');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.textContent).toBe(koMessages.content.channelPostsImageAttachTriggerCta);
  });

  it('②-a — 트리거 Button을 누르면 hidden input의 click이 위임된다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    const trigger = container.querySelector('[data-testid="channel-post-image-attach-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  // ③(유나 지적, 2026-09-04) — 썸네일 alt=""였던 것을 「첨부 이미지」 키로 채운다.
  it('⭐③ — 첨부 칸 미리보기 alt가 빈 문자열이 아니다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const img = container.querySelector('[data-testid="channel-post-image-preview"]') as HTMLImageElement;
    expect(img.alt).toBe(koMessages.content.channelPostsImageAttachAlt);
  });

  // 배지 첨부 칸(페드루 PO, 2026-09-04 13:41Z) — T3-M 미리보기도 파생본을 그리므로
  // was_converted면 승인 카드와 같은 배지·같은 문구를 함께 보인다.
  it('⭐배지 첨부 칸 — was_converted=true면 첨부 칸 미리보기 아래에도 승인 카드와 같은 변환 배지가 뜬다', async () => {
    stubFetch({ imageMaxCount: 1 });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const badge = container.querySelector('[data-testid="channel-post-image-attach-converted-badge"]')?.textContent ?? '';
    expect(badge).toContain('4000');
    expect(badge).toContain('1440');
  });

  it('⭐AC4 — CHANNEL_IMAGE_UNSUPPORTED_FORMAT(422) — 3요소(무엇이·허용목록) 문구가 조립된다', async () => {
    stubFetch({
      imageMaxCount: 1,
      onImageUploadUrl: () => ({
        status: 422,
        body: { detail: { code: 'CHANNEL_IMAGE_UNSUPPORTED_FORMAT', message: '…', content_type: 'image/gif', allowed_formats: ['image/jpeg', 'image/png'] } },
      }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.gif', { type: 'image/gif' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const errorText = container.querySelector('[data-testid="channel-post-image-upload-error"]')?.textContent ?? '';
    expect(errorText).toContain('image/gif');
    expect(errorText).toContain('image/jpeg');
    expect(container.querySelector('[data-testid="channel-post-image-preview"]')).toBeNull();
  });

  it('⭐AC4 — CHANNEL_IMAGE_TOO_LARGE(413) — MB 단위로 3요소 문구가 조립된다(confirm 단계에서 실패)', async () => {
    stubFetch({
      imageMaxCount: 1,
      onImageConfirm: () => ({
        status: 413,
        body: { detail: { code: 'CHANNEL_IMAGE_TOO_LARGE', message: '…', size_bytes: 30000000, max_bytes: 26214400 } },
      }),
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const errorText = container.querySelector('[data-testid="channel-post-image-upload-error"]')?.textContent ?? '';
    expect(errorText).toContain('28.6 MB');
    expect(errorText).toContain('25.0 MB');
  });
});

// story #3428(T5-M·§17-14) — 승인 카드 썸네일 + 자동 변환 배지.
describe('ChannelPostEditPage — 승인 카드 썸네일·배지(T5-M, story #3428)', () => {
  it('이미지 없는 초안(thumbnail_url=null)은 썸네일·배지 둘 다 안 그린다', async () => {
    stubFetch({ draftDetail: { thumbnail_url: null } as never });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-approval-thumbnail"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-image-converted-badge"]')).toBeNull();
  });

  it('⭐was_converted=true — 썸네일과 배지가 원본→최종 값 그대로 뜬다', async () => {
    stubFetch({
      draftDetail: {
        thumbnail_url: 'https://storage.googleapis.com/bucket/x.jpg',
        image_original_width: 4000, image_original_bytes: 12000000,
        image_final_width: 1440, image_final_bytes: 3100000, image_was_converted: true,
      } as never,
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-approval-thumbnail"]')).not.toBeNull();
    const badge = container.querySelector('[data-testid="channel-post-image-converted-badge"]')?.textContent ?? '';
    expect(badge).toContain('4000');
    expect(badge).toContain('1440');
    expect(badge).toContain('11.4 MB');
    expect(badge).toContain('3.0 MB');
  });

  it('⭐was_converted=false — 썸네일은 뜨되 배지는 안 뜬다(원본=최종)', async () => {
    stubFetch({
      draftDetail: {
        thumbnail_url: 'https://storage.googleapis.com/bucket/x.jpg',
        image_original_width: 800, image_original_bytes: 500000,
        image_final_width: 800, image_final_bytes: 500000, image_was_converted: false,
      } as never,
    });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-approval-thumbnail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-image-converted-badge"]')).toBeNull();
  });
});

// story #3428(§17-15, PO 확定 2026-09-04 12:19Z) — processing_kind 오버레이 우선순위
// 진리표 4행. processing_kind='awaiting_container'는 실데이터에서 항상 publication_
// status='container_created'와 함께 온다(BE 620beefc 판정식) — 즉 partialSuccess와
// 근본 상태를 공유하는 게 실제 겹침이다(행1). 그 겹침이 없을 때(processing_kind=null)
// 기존 partialSuccess/publicationFailed 분기는 무회귀(행2·3). unpublished는
// processing_kind와 절대 안 겹쳐야 하지만(published 이후에만 성립) 데이터 결함으로
// 겹치는 경우까지 unpublished를 우선한다(행4).
describe('ChannelPostEditPage — §17-15 processing_kind 오버레이 우선순위 진리표(story #3428)', () => {
  it('행1 — processing_kind=awaiting_container(+container_created) → 이어서 처리 중만, partialSuccess는 억제', async () => {
    stubFetch({ draftDetail: { publication_status: 'container_created', processing_kind: 'awaiting_container' } as never });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-awaiting-container-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-partial-success-notice"]')).toBeNull();
  });

  it('행2 — processing_kind=null·container_created → partialSuccess 그대로(무회귀)', async () => {
    stubFetch({ draftDetail: { publication_status: 'container_created', processing_kind: null } as never });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-partial-success-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-awaiting-container-notice"]')).toBeNull();
  });

  it('행3 — processing_kind=null·failed → publicationFailed 그대로(무회귀)', async () => {
    stubFetch({ draftDetail: { publication_status: 'failed', error_code: 'CHANNEL_PUBLISH_PROVIDER_ERROR', processing_kind: null } as never });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-publication-failed-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-awaiting-container-notice"]')).toBeNull();
  });

  it('행4 — unpublished + processing_kind(데이터 결함으로 동시 참) → unpublished 우선', async () => {
    stubFetch({ draftDetail: { publication_status: 'unpublished', processing_kind: 'awaiting_container' } as never });
    await act(async () => {
      root.render(wrap(<ChannelPostEditPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-unpublished-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="channel-post-awaiting-container-notice"]')).toBeNull();
  });
});

// story 15e481ce(#3453 AC2, 유나 §14-2) — "같은 스토리의 글"(정방향, 상세 머리).
// story #3457 후속(BE #3817 착지분) — source_title이 이제 단건 GET 응답에 직접
// 실려 별도 왕복(구 site-posts/drafts/{id}/versions)이 없다 — 이 스위트가 그 제거를
// pin한다(네트워크 호출 수 assert). staleness 배지(유나 정본 2026-09-04 20:57Z, #3453
// AC3 후속 페드루 PO 確定 2026-09-05로 판정 서버 이관) — source_changed 하나만 본다.
describe('ChannelPostEditPage — 같은 스토리의 글 + 배지(story 15e481ce AC2·#3457/#3453 AC3 후속, §14-2/§11-5)', () => {
  it('source_content_item_id가 없으면(정상값) 이 줄 자체가 안 그려진다', async () => {
    stubFetch({});
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-source-link"]')).toBeNull();
  });

  it('⭐source_title이 응답에 직접 실려 오면 별도 왕복 없이 "같은 스토리의 글" 링크로 보인다("원문" 단정 아님)', async () => {
    stubFetch({
      draftDetail: { source_content_item_id: 'site-1', source_title: '9월 실험 회고' },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const el = container.querySelector('[data-testid="channel-post-source-link"]');
    expect(el?.textContent).toContain(koMessages.content.channelPostsSourceLabel);
    expect(el?.textContent).toContain('9월 실험 회고');
    expect(el?.querySelector('a')?.getAttribute('href')).toBe('/content/site-1');
    // 구 워크어라운드(site-posts/drafts/{id}/versions)로의 호출이 0건 — 왕복 제거 pin.
    const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u) => u.includes('/site-posts/drafts/site-1/versions'))).toBe(false);
  });

  it('source_changed가 null(모른다, 레거시 파생분)이면 배지를 안 그린다', async () => {
    stubFetch({
      draftDetail: {
        source_content_item_id: 'site-1', source_title: '9월 실험 회고', source_changed: null,
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-source-changed-badge"]')).toBeNull();
  });

  it('source_changed가 false(원문 안 바뀜)면 배지를 안 그린다', async () => {
    stubFetch({
      draftDetail: {
        source_content_item_id: 'site-1', source_title: '9월 실험 회고', source_changed: false,
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-source-changed-badge"]')).toBeNull();
  });

  it('⭐source_changed=true(미발행)면 「만든 뒤 바뀜」 배지가 "같은 스토리의 글" 줄 옆에 뜬다', async () => {
    stubFetch({
      draftDetail: {
        source_content_item_id: 'site-1', source_title: '9월 실험 회고', source_changed: true,
        publication_status: null,
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const sourceLine = container.querySelector('[data-testid="channel-post-source-link"]');
    const badge = sourceLine?.querySelector('[data-testid="channel-post-source-changed-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(koMessages.content.channelPostsSourceChangedBadge);
    // 유나 정본 — StatusChip 색 톤이 아니라 SandboxTestBadge와 같은 무채 테두리(border-border).
    expect(badge?.className).toContain('border-border');
    expect(badge?.className).not.toContain('bg-warning');
    expect(badge?.className).not.toContain('bg-destructive');
  });

  it('⭐source_changed=true(발행됨)면 기록형 「만들 때 판 그대로」 배지로 갈린다(유나 §14-4 — "바뀌었습니다"는 고치려 든다)', async () => {
    stubFetch({
      draftDetail: {
        source_content_item_id: 'site-1', source_title: '9월 실험 회고', source_changed: true,
        publication_status: 'published',
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const badge = container.querySelector('[data-testid="channel-post-source-changed-badge"]');
    expect(badge?.textContent).toBe(koMessages.content.channelPostsSourceChangedBadgePublished);
    expect(badge?.textContent).not.toBe(koMessages.content.channelPostsSourceChangedBadge);
  });
});

// story #3454(유나 발견, PR#3798 Design review) — 서버 원문 raw가 8곳(저장·상신·이미지
// 업로드·발행·회수·재시도 + 유나가 안 짚은 회수 하나까지 §4-1과 같은 결함이라 함께 고침)
// 전부에서 담기만 하고 그리는 자리가 없던 것을 RawDetailsToggle(공용, content/[draftId]
// /page.tsx §4-1에서 뽑음)로 채운다. raw가 있으면 접힌 토글 렌더·펼치면 원문 노출·raw가
// 없으면(네트워크 예외 등) 토글 자체가 없는 것까지 각 자리에서 pin한다.
describe('ChannelPostEditPage — 서버 원문 접기(RawDetailsToggle, story #3454)', () => {
  function findRawToggle(root: ParentNode) {
    return [...root.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === koMessages.content.errorRawDetailsToggle,
    );
  }

  it('⭐저장 실패 — raw 토글이 접힌 채로 뜨고, 펼치면 서버 원문(code+message)이 그대로 보인다', async () => {
    stubFetch({
      onSave: () => ({ status: 422, body: { detail: { code: 'SOME_SAVE_ERROR', message: '저장 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const toggle = findRawToggle(container);
    expect(toggle).not.toBeUndefined();
    expect(toggle?.hasAttribute('open')).toBe(false);
    expect(toggle?.querySelector('pre')?.textContent).toBe(JSON.stringify({ code: 'SOME_SAVE_ERROR', message: '저장 실패 원문' }));
  });

  it('상신 실패(비-GATE_ALREADY_HELD) — raw 토글이 뜬다', async () => {
    stubFetch({
      onSubmit: () => ({ status: 500, body: { detail: { code: 'SOME_SUBMIT_ERROR', message: '상신 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  it('이미지 업로드 실패 — raw 토글이 뜬다', async () => {
    stubFetch({
      imageMaxCount: 1,
      onImageUploadUrl: () => ({ status: 422, body: { detail: { code: 'CHANNEL_IMAGE_UNSUPPORTED_FORMAT', message: '…', content_type: 'image/gif', allowed_formats: ['image/png'] } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const input = container.querySelector('[data-testid="channel-post-image-file-input"]') as HTMLInputElement;
    const file = new File(['x'], 'a.gif', { type: 'image/gif' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  it('발행 실패 — raw 토글이 뜬다', async () => {
    stubFetch({
      draftDetail: { gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1' },
      onPublish: () => ({ status: 502, body: { detail: { code: 'CHANNEL_PUBLISH_PROVIDER_ERROR', message: '발행 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const btn = container.querySelector('[data-testid="channel-post-publish-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  // 유나 Design FAIL(PR#3801 코멘트 5543611743, 페드루 PO 실물 대조) — 8곳 중
  // cancelScheduledResult 하나가 raw 자체를 안 담았다(핸들러가 info를 쥐고도 버림).
  it('⭐예약 취소 실패 — raw 토글이 뜬다(유나 FAIL — 8번째 자리)', async () => {
    stubFetch({
      draftDetail: { gate_status: 'pending', reapproval_required: false, command_status: 'pending' },
      onCancelScheduled: () => ({ status: 500, body: { detail: { code: 'SOME_CANCEL_ERROR', message: '예약 취소 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-cancel-scheduled-button"]') as HTMLButtonElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsCancelScheduledConfirmAction);
    await act(async () => { confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  it('⭐회수 실패 — raw 토글이 뜬다(티켓 밖 발견 — retryResult와 같은 결함이라 같이 고침)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://x', published_at: '2026-09-04T00:00:00Z',
      },
      onUnpublish: () => ({ status: 500, body: { detail: { code: 'SOME_UNPUBLISH_ERROR', message: '회수 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const trigger = container.querySelector('[data-testid="channel-post-unpublish-button"]') as HTMLButtonElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const confirmButton = [...document.body.querySelectorAll('button')].filter((b) => b !== trigger).find((b) => b.textContent === koMessages.content.channelPostsUnpublishConfirmAction);
    await act(async () => { confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  it('⭐재시도 실패 — raw 토글이 뜬다(retryResult에 raw 필드 자체가 없던 것을 이 스토리에서 추가)', async () => {
    stubFetch({
      draftDetail: { command_status: 'dead_letter', command_id: 'cmd-1' },
      onRetry: () => ({ status: 403, body: { detail: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', message: '재시도 실패 원문' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const retryBtn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const confirmBtn = [...document.body.querySelectorAll('button')].filter((b) => b !== retryBtn).find((b) => b.textContent === koMessages.content.channelPostsRetryConfirmAction) as HTMLButtonElement;
    await act(async () => { confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(findRawToggle(container)).not.toBeUndefined();
  });

  it('네트워크 예외(raw 자체가 없음) — 토글이 그려지지 않는다(지어내지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}`) {
        return { ok: true, status: 200, json: async () => ({ data: DRAFT_DETAIL, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts/${DRAFT_ID}/versions`) {
        return { ok: true, status: 200, json: async () => ({ data: [VERSION_1], error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        return { ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts` && init?.method === 'POST') {
        throw new Error('network down');
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    expect(container.textContent).toContain(koMessages.content.editSaveFailed);
    expect(findRawToggle(container)).toBeUndefined();
  });
});

// story #3472 2부(BE 3471/#3825 계약, 유나 §16-7 정본 2026-09-05) — 조직 콘텐츠
// 규칙 위반이 이 초안 화면에 어떻게 서는지. BE가 아직 병합 전이라 stub fetch로
// 계약(violations[{code,field,value,hint_key,settings_path}])만 먼저 검증한다.
describe('ChannelPostEditPage — 콘텐츠 규칙 위반 표시(story #3472 2부, §16-7)', () => {
  it('⭐저장 응답의 violations[] — 그 필드(text) 아래에만 표시되고 링크는 콘텐츠 규칙으로 간다', async () => {
    stubFetch({
      onSave: () => ({
        status: 201,
        body: {
          draft_id: DRAFT_ID, version_id: 'v2', version: 2,
          violations: [{ code: 'banned_term', field: 'text', value: '무료 보장', hint_key: 'x', settings_path: '/organization/content-rules' }],
        },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const textViolation = container.querySelector('[data-testid="channel-post-rule-violation-text"]');
    expect(textViolation?.textContent).toContain('무료 보장');
    expect(textViolation?.textContent).toBe(koMessages.content.contentRuleBannedTermBlockedHint.replace('{value}', '무료 보장') + ' ' + koMessages.content.contentRuleLinkLabel);
    expect(textViolation?.querySelector('a')?.getAttribute('href')).toBe('/organization/content-rules');
    // link_url 자리엔 안 새는지(필드별 분리).
    expect(container.querySelector('[data-testid="channel-post-rule-violation-link"]')).toBeNull();
  });

  it('⭐settings_path가 FE가 모르는 값이면 링크를 안 그린다(경로 결정권을 BE로 넘기지 않는다)', async () => {
    stubFetch({
      onSave: () => ({
        status: 201,
        body: { violations: [{ code: 'banned_term', field: 'text', value: 'x', hint_key: 'x', settings_path: '/some/other/path' }] },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    const textViolation = container.querySelector('[data-testid="channel-post-rule-violation-text"]');
    expect(textViolation?.querySelector('a')).toBeNull();
  });

  it('utm_missing — link_url 필드 아래에 UTM 3종 문구가 뜬다', async () => {
    stubFetch({
      onSave: () => ({
        status: 201,
        body: { violations: [{ code: 'utm_missing', field: 'link_url', value: 'https://x.example', hint_key: 'x', settings_path: '/organization/content-rules' }] },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-rule-violation-link"]')?.textContent)
      .toContain(koMessages.content.contentRuleUtmMissingBlockedHint);
    expect(container.querySelector('[data-testid="channel-post-rule-violation-text"]')).toBeNull();
  });

  it('⭐위반이 있으면 상신·예약상신 버튼이 비활성이고, 버튼 밖에 개수가 뜬다("이대로는 상신할 수 없습니다")', async () => {
    stubFetch({
      onSave: () => ({ status: 201, body: { violations: [{ code: 'banned_term', field: 'text', value: 'x', hint_key: 'x', settings_path: '/organization/content-rules' }] } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const saveBtn = container.querySelector('[data-testid="channel-post-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="channel-post-schedule-submit-button"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-rule-violation-blocked-reason"]')?.textContent)
      .toBe(koMessages.content.contentRuleSubmitBlockedHint.replace('{count}', '1'));
  });

  it('⭐상신 422 CONTENT_RULE_VIOLATION — 새 배너를 안 만들고 필드 옆 목록만 서버 응답으로 갱신한다', async () => {
    stubFetch({
      onSubmit: () => ({
        status: 422,
        body: {
          error: {
            code: 'CONTENT_RULE_VIOLATION', rules_version: 3,
            violations: [{ code: 'utm_missing', field: 'link_url', value: '', hint_key: 'x', settings_path: '/organization/content-rules' }],
          },
        },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-rule-violation-link"]')?.textContent)
      .toContain(koMessages.content.contentRuleUtmMissingBlockedHint);
    // 일반 오류 배너(submitResult)로는 안 뜬다 — 같은 말을 두 번 안 한다.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('위반이 없으면 저장·상신이 평소대로(회귀 0)', async () => {
    stubFetch({});
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="channel-post-rule-violation-text"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-rule-violation-blocked-reason"]')).toBeNull();
    expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(false);
  });

  // story #3514(lint-on-read, doc a0da40c9, PO 確定 2026-09-05) — 유나 13회차 ③ 관찰:
  // 규칙이 바뀐 뒤 기존 초안을 «열기만» 하면(저장·상신 없이) 위반 목록·상신 비활성이
  // 이미 서야 한다. 이 화면은 로드 시 이미 단건 GET을 부르므로(#3402) 그 응답의
  // violations를 그대로 초기값으로 쓰면 되는 자리 — save/submit 흐름과 별개로 검증.
  it('⭐로드만으로(저장·상신 없이) 단건 GET의 violations가 필드 옆 목록·상신 비활성으로 선다', async () => {
    stubFetch({
      draftDetail: {
        violations: [{ code: 'banned_term', field: 'text', value: '무료 보장', hint_key: 'x', settings_path: '/organization/content-rules' }],
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-rule-violation-text"]')?.textContent).toContain('무료 보장');
    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-post-rule-violation-blocked-reason"]')).not.toBeNull();
  });
});

describe('ChannelPostEditPage — 성과 인사이트 블록(story #3499, BE #3844 조각4 의존)', () => {
  it('publication_id 없음(BE 미착지 응답) — published 상태여도 인사이트 블록을 안 그린다', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://threads.net/@x/1', external_id: 'media-1',
        published_at: '2026-09-04T00:00:00Z', publication_id: null,
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-published-info"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-insight-info"]')).toBeNull();
  });

  it('publication_id 있음 — published 블록 안에 인사이트를 그리고 서버 값을 그대로 보인다(조립·판정 0)', async () => {
    stubFetch({
      draftDetail: {
        gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
        publication_status: 'published', permalink: 'https://threads.net/@x/1', external_id: 'media-1',
        published_at: '2026-09-04T00:00:00Z', publication_id: 'cp-1',
      },
      insightSnapshots: [
        {
          normalized: { impressions: 200, reach: 0, views: null, engagements: null, clicks: null, spend: null, conversions: null },
          captured_at: '2026-09-05T00:00:00Z', status: 'captured', due_at: '2026-09-05T00:00:00Z', source: 'threads',
        },
      ],
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const published = container.querySelector('[data-testid="channel-post-published-info"]')!;
    const insight = published.querySelector('[data-testid="content-insight-info"]');
    expect(insight).not.toBeNull();
    const values = Array.from(insight!.querySelectorAll('[data-testid="insight-metric-value"]')).map((el) => el.textContent);
    expect(values).toContain('200');
    expect(values).toContain('0');
  });
});

// story #3517(Phase2·FE, BE #3865 조각①, 그라운딩 ① 삽입 지점) — 발행됨 오버레이 안,
// InsightSnapshotBlock과 같은 조건(publication_id 있을 때만).
describe('ChannelPostEditPage — 댓글 섹션(story #3517)', () => {
  const PUBLISHED_DRAFT = {
    gate_status: 'approved', sealed_content_sha256: 'h1', body_sha256: 'h1',
    publication_status: 'published', permalink: 'https://threads.net/@x/1', external_id: 'media-1',
    published_at: '2026-09-04T00:00:00Z', publication_id: 'cp-1',
  } as const;

  it('publication_id 없으면 댓글 섹션 자체를 안 그린다', async () => {
    stubFetch({ draftDetail: { ...PUBLISHED_DRAFT, publication_id: null } });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="comments-section"]')).toBeNull();
  });

  it('last_collected_at=null — uncollected 얼굴("아직 수집 전")', async () => {
    stubFetch({ draftDetail: PUBLISHED_DRAFT, commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 } });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const published = container.querySelector('[data-testid="channel-post-published-info"]')!;
    expect(published.querySelector('[data-testid="comments-face-uncollected"]')).not.toBeNull();
  });

  it('댓글 GET 500 — error 얼굴("불러오지 못했습니다"), 화면 전체는 안 막힌다', async () => {
    stubFetch({ draftDetail: PUBLISHED_DRAFT, commentsStatus: 500 });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const published = container.querySelector('[data-testid="channel-post-published-info"]')!;
    expect(published.querySelector('[data-testid="comments-face-error"]')).not.toBeNull();
    // 화면 전체는 안 막혔다 — permalink 등 주 데이터가 그대로 보인다.
    expect(container.querySelector('a[href="https://threads.net/@x/1"]')).not.toBeNull();
  });

  it('댓글 n건 — 목록·작성자·본문이 서버 응답 그대로 뜬다', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: {
        last_collected_at: '2026-09-05T10:00:00Z', active_count: 1, deleted_count: 0,
        comments: [{
          id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: '좋은 글이네요',
          external_created_at: '2026-09-05T09:00:00Z', captured_at: '2026-09-05T10:00:00Z', deleted_at: null,
        }],
      },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const published = container.querySelector('[data-testid="channel-post-published-info"]')!;
    expect(published.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe('홍길동');
    expect(published.querySelector('[data-testid="comment-body-text"]')?.textContent).toContain('좋은 글이네요');
  });

  // story #3517(BE #3867 조각②, PO 確定 2026-09-05) — 행 액션 재도입.
  it('「작업으로 전환」 클릭 — 다이얼로그가 열리고 실 BFF로 전환된다(성공 시 story 링크)', async () => {
    let captured: unknown = null;
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: {
        last_collected_at: '2026-09-05T10:00:00Z', active_count: 1, deleted_count: 0,
        comments: [{
          id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: '이 부분 설명이 부족해요',
          external_created_at: '2026-09-05T09:00:00Z', captured_at: '2026-09-05T10:00:00Z', deleted_at: null,
        }],
      },
      onCommentFollowUp: (body) => { captured = body; return { status: 201, body: { story_id: 'story-42' } }; },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-item-convert-to-task"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.commentsConvertSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
    expect(captured).toMatchObject({ title: expect.stringContaining('[댓글]') });
    expect(document.querySelector('[data-testid="comments-convert-success-link"]')?.getAttribute('href')).toBe('/board?story=story-42');
  });

  it('「작업으로 전환」 403(에이전트 차단) — 서버 문구가 그대로 뜬다', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: {
        last_collected_at: '2026-09-05T10:00:00Z', active_count: 1, deleted_count: 0,
        comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: 'x', external_created_at: null, captured_at: '2026-09-05T10:00:00Z', deleted_at: null }],
      },
      onCommentFollowUp: () => ({ status: 403, body: { detail: { code: 'COMMENT_REPLY_HUMAN_ONLY', message: '이 액션은 휴먼 멤버만 가능합니다.' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-item-convert-to-task"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.content.commentsConvertSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
    expect(document.querySelector('[data-testid="comments-convert-error"]')?.textContent).toBe('이 액션은 휴먼 멤버만 가능합니다.');
  });

  it('「답변」 클릭 — 초안 저장→상신까지 실 BFF로 진행되고 성공 문구가 뜬다', async () => {
    let draftedText = '';
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: {
        last_collected_at: '2026-09-05T10:00:00Z', active_count: 1, deleted_count: 0,
        comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: '언제 재입고되나요?', external_created_at: null, captured_at: '2026-09-05T10:00:00Z', deleted_at: null }],
      },
      onCommentReplyDraft: (body) => {
        draftedText = (body as { text: string }).text;
        return { status: 201, body: { id: 'reply-1', comment_id: 'c1', text: draftedText, status: 'draft', gate_id: null, external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: null } };
      },
      onCommentReplySubmit: () => ({
        status: 200,
        body: { id: 'reply-1', comment_id: 'c1', text: draftedText, status: 'pending', gate_id: 'gate-1', external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: 'current' },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-item-reply"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const textarea = document.querySelector('#comments-reply-text') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, '다음 주 월요일에 재입고됩니다'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('[data-testid="comments-reply-sealed-text"]')?.textContent).toBe('다음 주 월요일에 재입고됩니다');
  });

  it('「답변」 상신 409(대상 삭제) — 서버 문구가 그대로 뜬다', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: {
        last_collected_at: '2026-09-05T10:00:00Z', active_count: 1, deleted_count: 0,
        comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: 'x', external_created_at: null, captured_at: '2026-09-05T10:00:00Z', deleted_at: null }],
      },
      onCommentReplySubmit: () => ({ status: 409, body: { detail: { code: 'COMMENT_REPLY_TARGET_DELETED', message: '답변 대상 댓글이 삭제되어 상신할 수 없습니다.' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-item-reply"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const textarea = document.querySelector('#comments-reply-text') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, 'x'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('[data-testid="comments-reply-error"]')?.textContent).toBe('답변 대상 댓글이 삭제되어 상신할 수 없습니다.');
  });

  // story #3517(BE #3865 조각①) — 수동 재수집. 429/422/403 문장을 서버 응답 그대로
  // 보인다(재해석·재작성 0).
  it('재수집 성공 — 목록을 다시 불러온다(POST 뒤 GET 재조회)', async () => {
    let getCallCount = 0;
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => { getCallCount += 1; return { status: 200, body: { fetched: 1, deleted: 0, captured_at: '2026-09-05T12:00:00Z' } }; },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(getCallCount).toBe(1);
    expect(container.querySelector('[data-testid="comments-refresh-error"]')).toBeNull();
  });

  // story #3517(유나 §22-10③) — 429는 버튼 비활성+버튼 밖 「{N}초 뒤에…」(Retry-After
  // 헤더를 그대로 읽는다, 지어내지 않는다).
  it('재수집 429 COMMENT_REFRESH_RATE_LIMITED — 버튼 비활성+Retry-After 초 문구', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => ({
        status: 429, headers: { 'Retry-After': '60' },
        body: { detail: { code: 'COMMENT_REFRESH_RATE_LIMITED', message: '잠시 후 다시 시도해 주세요' } },
      }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(btn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('60초 뒤에 다시 시도할 수 있습니다.');
  });

  it('재수집 429, Retry-After 헤더 없음 — 초를 지어내지 않고 "잠시 뒤"', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => ({ status: 429, body: { detail: { code: 'COMMENT_REFRESH_RATE_LIMITED', message: 'x' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="comments-refresh-rate-limited"]')?.textContent).toBe('잠시 뒤에 다시 시도할 수 있습니다.');
  });

  // story #3517(유나 §22-10③) — 422 unsupported는 버튼 자체가 사라진다(네 번째 얼굴).
  it('재수집 422 COMMENT_COLLECTION_UNSUPPORTED — 버튼이 사라지고 지원 안 함 문구만', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => ({ status: 422, body: { detail: { code: 'COMMENT_COLLECTION_UNSUPPORTED', message: '이 채널은 댓글 수집을 지원하지 않습니다' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="comments-refresh-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-refresh-unsupported"]')?.textContent).toBe('이 채널은 댓글을 지원하지 않습니다.');
  });

  it('재수집 403 COMMENT_REFRESH_HUMAN_ONLY — 서버 문구를 그대로 보인다', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => ({ status: 403, body: { detail: { code: 'COMMENT_REFRESH_HUMAN_ONLY', message: '사람만 다시 수집할 수 있습니다' } } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="comments-refresh-error"]')?.textContent).toBe('사람만 다시 수집할 수 있습니다');
  });

  it('재수집 502(채널 fetch 실패) — flat {code,message} shape도 그대로 보인다', async () => {
    stubFetch({
      draftDetail: PUBLISHED_DRAFT,
      commentsResponse: { last_collected_at: null, comments: [], active_count: 0, deleted_count: 0 },
      onCommentsRefresh: () => ({ status: 502, body: { code: 'CHANNEL_FETCH_FAILED', message: '채널에서 응답을 받지 못했습니다' } }),
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    const btn = container.querySelector('[data-testid="comments-refresh-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="comments-refresh-error"]')?.textContent).toBe('채널에서 응답을 받지 못했습니다');
  });
});

describe('ChannelPostEditPage — 생성 비용 한도(story #3500, doc a0da40c9 §19 — BE #3498 미착지, 계약 fixture)', () => {
  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('예상 비용을 입력하지 않으면 submit body에 estimated_cost_minor가 없다', async () => {
    let submittedBody: unknown = null;
    stubFetch({ onSubmit: (body) => { submittedBody = body; return { status: 200, body: { gate_id: 'g1', version_id: 'v1', content_sha256: 'h1', status: 'pending' } }; } });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect((submittedBody as { estimated_cost_minor?: number } | null)?.estimated_cost_minor).toBeUndefined();
  });

  it('예상 비용을 입력하면 submit body에 정수로 실린다', async () => {
    let submittedBody: unknown = null;
    stubFetch({
      onSubmit: (body) => { submittedBody = body; return { status: 200, body: { gate_id: 'g1', version_id: 'v1', content_sha256: 'h1', status: 'pending' } }; },
      // PO REQUIRED②(2026-09-05) — 입력은 generationBudgetUsable(ok && limit/currency/
      // remaining 전부 non-null)일 때만 그려진다. 이 mock이 없으면 입력 자체가 안
      // 그려져 setInputValue가 null에 걸린다(§19-1의 "통화 모르면 입력 안 받는다"
      // 규율이 테스트에도 그대로 적용된 것 — mock 갱신이지 회귀가 아니다).
      genBudgetOk: { limit_minor: 500000, spent_minor: 0, remaining_minor: 500000, currency: 'KRW', period: 'month' },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="channel-post-estimated-cost-input"]') as HTMLInputElement;
    await act(async () => { setInputValue(costInput, '5000'); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect((submittedBody as { estimated_cost_minor?: number } | null)?.estimated_cost_minor).toBe(5000);
  });

  it('⭐예상 비용(USD, exponent 2) — 큰단위×100이 분단위로 실린다(§19-1 회귀 방지)', async () => {
    let submittedBody: unknown = null;
    stubFetch({
      onSubmit: (body) => { submittedBody = body; return { status: 200, body: { gate_id: 'g1', version_id: 'v1', content_sha256: 'h1', status: 'pending' } }; },
      genBudgetOk: { limit_minor: 100000, spent_minor: 0, remaining_minor: 100000, currency: 'USD', period: 'month' },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="channel-post-estimated-cost-input"]') as HTMLInputElement;
    // 큰단위로 "5"(=$5) 입력 — exponent 변환을 빼먹으면 500이 아닌 5가 그대로 실린다.
    await act(async () => { setInputValue(costInput, '5'); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect((submittedBody as { estimated_cost_minor?: number } | null)?.estimated_cost_minor).toBe(500);
  });

  it('⭐422 GENERATION_BUDGET_EXCEEDED — 전역 배너에 4값이 보간되고 입력값은 지워지지 않는다', async () => {
    stubFetch({
      onSubmit: () => ({
        status: 422,
        body: { error: { code: 'GENERATION_BUDGET_EXCEEDED', limit_minor: 100000, spent_minor: 90000, estimated_cost_minor: 20000, remaining_minor: 10000 } },
      }),
      genBudgetOk: { limit_minor: 100000, spent_minor: 90000, remaining_minor: 10000, currency: 'KRW', period: 'month' },
    });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();

    const costInput = container.querySelector('[data-testid="channel-post-estimated-cost-input"]') as HTMLInputElement;
    await act(async () => { setInputValue(costInput, '20000'); });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    // doc a0da40c9 §19-8 — 구조화 배너(사실 문장→4값 두 칸 목록→행동 문장), §19-1
    // 콤마 포맷.
    const banner = container.querySelector('[data-testid="generation-budget-exceeded-banner"]');
    expect(banner?.textContent).toContain(koMessages.content.generationBudgetExceededFact);
    expect(container.querySelector('[data-testid="generation-budget-exceeded-limit"]')?.textContent).toBe('100,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-spent"]')?.textContent).toBe('90,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-estimated"]')?.textContent).toBe('20,000원');
    expect(container.querySelector('[data-testid="generation-budget-exceeded-remaining"]')?.textContent).toBe('10,000원');
    expect(banner?.textContent).toContain(koMessages.content.generationBudgetExceededAction);
    // 입력값이 안 지워진다(서버 오류 시 재입력 안 해도 되게, ScheduleAtDialog 관례와 동형).
    expect(costInput.value).toBe('20000');
  });

  it('정책 미설정(limit_minor=null)이면 잔량 표시가 아무것도 안 그린다', async () => {
    stubFetch({ genBudgetOk: { limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' } });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="generation-budget-remaining-compact"]')).toBeNull();
  });

  it('잔량 조회 실패해도 저장·상신 버튼은 막히지 않는다(§3-2 "모른다≠0")', async () => {
    stubFetch({ genBudgetOk: false });
    await act(async () => { root.render(wrap(<ChannelPostEditPage />)); });
    await flush();
    expect(container.querySelector('[data-testid="generation-budget-failed"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="channel-post-submit-button"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
