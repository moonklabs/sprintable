import { describe, test, expect } from 'vitest';
import { parseSitePostApiError } from './api-error';

describe('parseSitePostApiError (story #3368, doc phase0-post-manager-screen-design §4-1)', () => {
  test('알려진 코드(MEDIA_NOT_SUPPORTED_PHASE0) — humanMessageKey가 채워지고 raw도 보존된다', () => {
    const result = parseSitePostApiError({ detail: { code: 'MEDIA_NOT_SUPPORTED_PHASE0', message: 'Phase 0은 미디어 입력을 지원하지 않습니다' } });
    expect(result.humanMessageKey).toBe('errorMediaNotSupported');
    expect(result.raw).toContain('MEDIA_NOT_SUPPORTED_PHASE0');
    expect(result.raw).toContain('미디어');
  });

  test('알려진 코드(SITE_POST_PUBLISH_HUMAN_ONLY)', () => {
    const result = parseSitePostApiError({ detail: { code: 'SITE_POST_PUBLISH_HUMAN_ONLY', message: '글 공개는 휴먼 멤버만 가능합니다' } });
    expect(result.humanMessageKey).toBe('errorPublishHumanOnly');
  });

  // story #3386 — 「발행 취소」 버튼(story #3381, PR#3739)의 두 권한 오류.
  test('알려진 코드(SITE_POST_UNPUBLISH_HUMAN_ONLY)', () => {
    const result = parseSitePostApiError({ detail: { code: 'SITE_POST_UNPUBLISH_HUMAN_ONLY', message: '발행 취소는 휴먼 멤버만 가능합니다' } });
    expect(result.humanMessageKey).toBe('errorUnpublishHumanOnly');
    expect(result.kind).toBe('permission');
  });

  test('알려진 코드(SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY)', () => {
    const result = parseSitePostApiError({
      detail: { code: 'SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY', message: '발행 취소는 조직 owner 또는 admin만 가능합니다' },
    });
    expect(result.humanMessageKey).toBe('errorUnpublishOwnerOrAdminOnly');
    expect(result.kind).toBe('permission');
  });

  test('⭐모르는 코드 — 지어낸 문구로 덮지 않고 서버 원문 메시지를 그대로 fallback에 담는다', () => {
    const result = parseSitePostApiError({ detail: { code: 'SOME_FUTURE_S2_CODE', message: '아직 모르는 에러' } });
    expect(result.humanMessageKey).toBeUndefined();
    expect(result.humanMessageFallback).toBe('아직 모르는 에러');
    expect(result.raw).toContain('SOME_FUTURE_S2_CODE');
  });

  test('detail이 순수 문자열(코드 없음) — message로만 처리, raw에도 실린다', () => {
    const result = parseSitePostApiError({ detail: 'org_id mismatch' });
    expect(result.humanMessageFallback).toBe('org_id mismatch');
    expect(result.raw).toContain('org_id mismatch');
  });

  test('body가 null(파싱 실패) — 빈 문자열 fallback, raw는 null 쌍으로 안전하게 직렬화', () => {
    const result = parseSitePostApiError(null);
    expect(result.humanMessageFallback).toBe('');
    expect(() => JSON.parse(result.raw)).not.toThrow();
  });

  // 페드루 PO 지시(2026-09-03, doc §8-3④-1) — 403/409를 한 문구로 뭉치지 않는다. 사람이
  // 되돌릴 행동이 갈래마다 다르다(기다린다/권한 요청/재상신/봉인없음/재상신대기).
  test('⭐kind 6칸 — 서로 다른 갈래가 서로 다른 kind로 갈린다', () => {
    const approvalRequired = parseSitePostApiError({
      detail: { code: 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED', message: 'gate_id=g1, status=pending' },
    });
    expect(approvalRequired.kind).toBe('approval_required');
    expect(approvalRequired.humanMessageKey).toBe('errorApprovalRequired');

    const permission = parseSitePostApiError({
      detail: { code: 'SITE_POST_PUBLISH_HUMAN_ONLY', message: '글 공개는 휴먼 멤버만 가능합니다' },
    });
    expect(permission.kind).toBe('permission');

    const reapprovalRequired = parseSitePostApiError({
      detail: { code: 'SITE_POST_REAPPROVAL_REQUIRED', message: 'gate_id=g1, sealed=abc, current=xyz' },
    });
    expect(reapprovalRequired.kind).toBe('reapproval_required');
    expect(reapprovalRequired.humanMessageKey).toBe('errorReapprovalRequired');

    const sealMissing = parseSitePostApiError({
      detail: { code: 'SITE_POST_SEAL_MISSING', message: 'gate_id=g1' },
    });
    expect(sealMissing.kind).toBe('seal_missing');
    expect(sealMissing.humanMessageKey).toBe('errorSealMissing');

    const resubmitRequired = parseSitePostApiError({
      detail: { code: 'SITE_POST_RESUBMIT_REQUIRED', message: '승인 뒤 내용이 바뀌었습니다' },
    });
    expect(resubmitRequired.kind).toBe('resubmit_required');
    expect(resubmitRequired.humanMessageKey).toBe('errorResubmitRequired');

    const unknown = parseSitePostApiError({ detail: { code: 'SOME_FUTURE_CODE', message: '모름' } });
    expect(unknown.kind).toBe('unknown');

    // 여섯 다 서로 다른 값 — 하나로 뭉쳐지지 않는다(§8-3④-1 핵심).
    const kinds = new Set([
      approvalRequired.kind, permission.kind, reapprovalRequired.kind,
      sealMissing.kind, resubmitRequired.kind, unknown.kind,
    ]);
    expect(kinds.size).toBe(6);
  });

  test('레거시 endpoint(POST /site-posts)의 EXTERNAL_PUBLISH 403은 여전히 평문 문자열이라 kind=unknown', () => {
    // site_posts.py::post_site_post(구 agent 스크립트 경로)는 ExternalPublishGateNotApprovedError를
    // 여전히 detail=str(exc)로 감싼다(code 필드 없음) — S3의 신규 draft 기반 endpoint만 구조화
    // 코드를 낸다. 이 차이 자체가 실물이라 회귀로 고정한다(§8-1 5단 발행 화면은 신규 endpoint만
    // 쓰므로 영향 없음).
    const result = parseSitePostApiError({ detail: 'external_publish 게이트가 승인되지 않았습니다(gate_id=g1, status=pending)' });
    expect(result.kind).toBe('unknown');
    expect(result.humanMessageFallback).toContain('gate_id=g1');
  });

  // story f6d14476(AC1·AC3) — SITE_POST_GATE_ALREADY_HELD. main.py::http_exception_handler의
  // 실제 응답 봉투는 "error"(not "detail") — 그 형상으로 읽는다. labelKey는 일부러 비운다
  // (title은 서버가 안 준다, page.tsx가 heldByDraftId로 별도 조회해 문구를 조립한다) — 그래서
  // humanMessageKey는 undefined, kind와 heldBy* 필드만으로 화면이 판단한다.
  test('⭐SITE_POST_GATE_ALREADY_HELD(error 봉투) — kind·heldBy* 필드가 채워지고 humanMessageKey는 비워둔다(title은 화면이 채운다)', () => {
    const result = parseSitePostApiError({
      error: {
        code: 'SITE_POST_GATE_ALREADY_HELD',
        message: '이 work item은 다른 초안이 이미 승인 절차 중입니다(holding_draft_id=d1, lang=ko, slug=a-blog)',
        holding_draft_id: 'd1', holding_lang: 'ko', holding_slug: 'a-blog',
      },
    });
    expect(result.kind).toBe('gate_already_held');
    expect(result.humanMessageKey).toBeUndefined();
    expect(result.heldByDraftId).toBe('d1');
    expect(result.heldByLang).toBe('ko');
    expect(result.heldBySlug).toBe('a-blog');
    expect(result.raw).toContain('SITE_POST_GATE_ALREADY_HELD');
  });

  test('SITE_POST_GATE_ALREADY_HELD — detail 형상(방어 경로)에서도 동일하게 파싱된다', () => {
    const result = parseSitePostApiError({
      detail: {
        code: 'SITE_POST_GATE_ALREADY_HELD', message: '…',
        holding_draft_id: 'd2', holding_lang: 'en', holding_slug: 'b-blog',
      },
    });
    expect(result.kind).toBe('gate_already_held');
    expect(result.heldByDraftId).toBe('d2');
    expect(result.heldByLang).toBe('en');
    expect(result.heldBySlug).toBe('b-blog');
  });

  test('다른 코드엔 heldBy* 필드가 전혀 안 실린다(회귀 방지)', () => {
    const result = parseSitePostApiError({
      error: { code: 'SITE_POST_REAPPROVAL_REQUIRED', message: '…' },
    });
    expect(result.heldByDraftId).toBeUndefined();
    expect(result.heldByLang).toBeUndefined();
    expect(result.heldBySlug).toBeUndefined();
  });

  // story #3402(Phase1·마케팅운영, 유나 doc §5 v8 정본) — 채널 포스트 화면 12행. 각 코드가
  // 서로 다른 kind로 갈리고(사람이 되돌릴 행동이 다르므로), 부가 필드(reset_at 등)가 실린다.
  describe('채널 포스트 12행(story #3402, doc §5 v8)', () => {
    test('CHANNEL_RATE_LIMITED — kind=rate_limited·resetAt이 실린다', () => {
      const result = parseSitePostApiError({
        error: { code: 'CHANNEL_RATE_LIMITED', message: '한도 초과', reset_at: '2026-09-05T00:00:00Z' },
      });
      expect(result.kind).toBe('rate_limited');
      expect(result.humanMessageKey).toBe('errorChannelRateLimited');
      expect(result.resetAt).toBe('2026-09-05T00:00:00Z');
    });

    test('CHANNEL_TOKEN_EXPIRED — kind=token_expired', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_TOKEN_EXPIRED', message: '토큰 만료' } });
      expect(result.kind).toBe('token_expired');
      expect(result.humanMessageKey).toBe('errorChannelTokenExpired');
    });

    test('CHANNEL_CONNECTION_NOT_ACTIVE — kind=connection_not_active', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', message: '연결 비활성' } });
      expect(result.kind).toBe('connection_not_active');
      expect(result.humanMessageKey).toBe('errorChannelConnectionNotActive');
    });

    test('CHANNEL_POST_APPROVER_ROLE_MISSING — kind=approver_role_missing', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_POST_APPROVER_ROLE_MISSING', message: '승인자 없음' } });
      expect(result.kind).toBe('approver_role_missing');
      expect(result.humanMessageKey).toBe('errorChannelApproverRoleMissing');
    });

    test('CHANNEL_POST_PUBLISH_HUMAN_ONLY — kind=permission(site와 동일 갈래 공유)', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', message: '휴먼 전용' } });
      expect(result.kind).toBe('permission');
      expect(result.humanMessageKey).toBe('errorChannelPublishHumanOnly');
    });

    test('CHANNEL_PUBLISH_IN_PROGRESS(story #3395) — kind=publish_in_progress', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_PUBLISH_IN_PROGRESS', message: '경합 처리 중' } });
      expect(result.kind).toBe('publish_in_progress');
      expect(result.humanMessageKey).toBe('errorChannelPublishInProgress');
    });

    test('CHANNEL_TEXT_TOO_LONG — kind=text_too_long·maxLength/currentLength가 실리고 humanMessageKey는 비워 page.tsx가 조립', () => {
      const result = parseSitePostApiError({
        error: { code: 'CHANNEL_TEXT_TOO_LONG', message: '한도 초과', max_length: 500, current_length: 517 },
      });
      expect(result.kind).toBe('text_too_long');
      expect(result.humanMessageKey).toBeUndefined();
      expect(result.maxLength).toBe(500);
      expect(result.currentLength).toBe(517);
    });

    // 카디르 라이브 실측(2026-09-04, 별도 플러그인 결함 — 그 소비부가 detail로 잘못 읽던
    // 것과는 무관) — 이 함수 자체는 실제 BE 봉투 원문(main.py::http_exception_handler,
    // {"data":null,"error":{...},"meta":null})으로도 정확히 파싱되는지 손 mock이 아니라
    // 와이어 그대로의 JSON 문자열을 파싱해 재확認한다.
    test('⭐실 BE 봉투 원문(JSON.parse, error 층) — CHANNEL_CONNECTION_NOT_ACTIVE가 정확히 파싱된다', () => {
      const wire = '{"data":null,"error":{"code":"CHANNEL_CONNECTION_NOT_ACTIVE","message":"연결을 찾을 수 없거나 비활성 상태입니다: 11111111-1111-1111-1111-111111111111"},"meta":null}';
      const result = parseSitePostApiError(JSON.parse(wire));
      expect(result.kind).toBe('connection_not_active');
      expect(result.humanMessageKey).toBe('errorChannelConnectionNotActive');
      expect(result.humanMessageFallback).toContain('연결을 찾을 수 없거나');
    });

    test('⭐실 BE 봉투 원문 — reset_at·max_length 같은 부가 필드도 error 층에서 정확히 읽힌다', () => {
      const rateLimitedWire = '{"data":null,"error":{"code":"CHANNEL_RATE_LIMITED","message":"한도 초과","reset_at":"2026-09-05T09:00:00Z"},"meta":null}';
      expect(parseSitePostApiError(JSON.parse(rateLimitedWire)).resetAt).toBe('2026-09-05T09:00:00Z');

      const textTooLongWire = '{"data":null,"error":{"code":"CHANNEL_TEXT_TOO_LONG","message":"한도 초과","max_length":500,"current_length":517},"meta":null}';
      const textTooLong = parseSitePostApiError(JSON.parse(textTooLongWire));
      expect(textTooLong.maxLength).toBe(500);
      expect(textTooLong.currentLength).toBe(517);

      const heldWire = '{"data":null,"error":{"code":"CHANNEL_POST_GATE_ALREADY_HELD","message":"…","holding_draft_id":"d9","holding_channel":"threads","holding_connection_id":"c9"},"meta":null}';
      const held = parseSitePostApiError(JSON.parse(heldWire));
      expect(held.heldByDraftId).toBe('d9');
      expect(held.heldByChannel).toBe('threads');
      expect(held.heldByConnectionId).toBe('c9');
    });

    test('EXTERNAL_PUBLISH_APPROVAL_REQUIRED·SITE_POST_SEAL_MISSING·SITE_POST_REAPPROVAL_REQUIRED — site 항목을 그대로 재사용(doc §9-4)', () => {
      expect(parseSitePostApiError({ error: { code: 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED', message: '…' } }).kind).toBe('approval_required');
      expect(parseSitePostApiError({ error: { code: 'SITE_POST_SEAL_MISSING', message: '…' } }).kind).toBe('seal_missing');
      expect(parseSitePostApiError({ error: { code: 'SITE_POST_REAPPROVAL_REQUIRED', message: '…' } }).kind).toBe('reapproval_required');
    });

    test('CHANNEL_PUBLISH_PROVIDER_ERROR — kind=provider_error', () => {
      const result = parseSitePostApiError({ error: { code: 'CHANNEL_PUBLISH_PROVIDER_ERROR', message: 'provider 원문' } });
      expect(result.kind).toBe('provider_error');
      expect(result.humanMessageKey).toBe('errorChannelPublishProviderError');
      expect(result.humanMessageFallback).toBe('provider 원문');
    });

    // story #3402·PR#3764 c6049add1 — CHANNEL_POST_GATE_ALREADY_HELD. site와 kind는 같지만
    // (같은 "그 초안 보기" 분기) 부가 필드가 다르다 — slug/lang 없음, channel/connection_id 대신.
    test('⭐CHANNEL_POST_GATE_ALREADY_HELD — kind=gate_already_held(site와 공유)·heldByChannel/heldByConnectionId가 실리고 heldBySlug/heldByLang은 없다', () => {
      const result = parseSitePostApiError({
        error: {
          code: 'CHANNEL_POST_GATE_ALREADY_HELD',
          message: '같은 work item의 다른 초안이 승인 절차 중',
          holding_draft_id: 'd3', holding_channel: 'threads', holding_connection_id: 'conn1',
        },
      });
      expect(result.kind).toBe('gate_already_held');
      expect(result.humanMessageKey).toBeUndefined();
      expect(result.heldByDraftId).toBe('d3');
      expect(result.heldByChannel).toBe('threads');
      expect(result.heldByConnectionId).toBe('conn1');
      expect(result.heldBySlug).toBeUndefined();
      expect(result.heldByLang).toBeUndefined();
    });

    test('12행 전부 서로 다른 kind이거나(고유 코드) site와 의도적으로 공유하는 kind(permission·gate_already_held·approval_required·seal_missing·reapproval_required)뿐이다', () => {
      const codes = [
        'CHANNEL_RATE_LIMITED', 'CHANNEL_TOKEN_EXPIRED', 'CHANNEL_CONNECTION_NOT_ACTIVE',
        'CHANNEL_POST_APPROVER_ROLE_MISSING', 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', 'CHANNEL_PUBLISH_IN_PROGRESS',
        'CHANNEL_TEXT_TOO_LONG', 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED', 'SITE_POST_SEAL_MISSING',
        'SITE_POST_REAPPROVAL_REQUIRED', 'CHANNEL_POST_GATE_ALREADY_HELD', 'CHANNEL_PUBLISH_PROVIDER_ERROR',
      ];
      const kinds = codes.map((code) => parseSitePostApiError({ error: { code, message: '…' } }).kind);
      expect(kinds).not.toContain('unknown');
      expect(kinds).toHaveLength(12);
    });

    // story #3428(BE 620beefc·PR#3776) — CHANNEL_IMAGE_* 9종. channel_posts.py 라우터
    // except 매핑 실측 그대로(각 코드가 싣는 부가 필드가 다르다).
    describe('CHANNEL_IMAGE_* (story #3428)', () => {
      test('CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED(503) — kind=image_storage_not_configured, 고정 문구', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED', message: '…' } });
        expect(result.kind).toBe('image_storage_not_configured');
        expect(result.humanMessageKey).toBe('errorChannelImageStorageNotConfigured');
      });

      test('CHANNEL_IMAGE_UNSUPPORTED(422) — kind=image_unsupported·channel 필드 보존(채널 미지원, 사용자가 못 바꿈)', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_UNSUPPORTED', message: '…', channel: 'threads' } });
        expect(result.kind).toBe('image_unsupported');
        expect(result.humanMessageKey).toBe('errorChannelImageUnsupported');
        expect(result.imageChannel).toBe('threads');
      });

      test('CHANNEL_IMAGE_UNSUPPORTED_FORMAT(422) — CHANNEL_IMAGE_UNSUPPORTED와 접두 관계지만 다른 kind로 정확히 갈린다(=== 매핑)', () => {
        const result = parseSitePostApiError({
          error: { code: 'CHANNEL_IMAGE_UNSUPPORTED_FORMAT', message: '…', content_type: 'image/gif', allowed_formats: ['image/jpeg', 'image/png'] },
        });
        expect(result.kind).toBe('image_unsupported_format');
        expect(result.kind).not.toBe('image_unsupported');
        expect(result.humanMessageKey).toBeUndefined();
        expect(result.imageContentType).toBe('image/gif');
        expect(result.imageAllowedFormats).toEqual(['image/jpeg', 'image/png']);
      });

      test('CHANNEL_IMAGE_TOO_LARGE(413) — kind=image_too_large·size_bytes/max_bytes 보존', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_TOO_LARGE', message: '…', size_bytes: 30000000, max_bytes: 26214400 } });
        expect(result.kind).toBe('image_too_large');
        expect(result.imageSizeBytes).toBe(30000000);
        expect(result.imageMaxBytes).toBe(26214400);
      });

      test('CHANNEL_IMAGE_UNDECODABLE(422) — 고정 문구, 부가 필드 없음', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_UNDECODABLE', message: '…' } });
        expect(result.kind).toBe('image_undecodable');
        expect(result.humanMessageKey).toBe('errorChannelImageUndecodable');
      });

      test('CHANNEL_IMAGE_ANIMATED_UNSUPPORTED(422) — frame_count만 보존(§13 "무엇이"만, 얼마까지/지금 얼마는 생략)', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_ANIMATED_UNSUPPORTED', message: '…', frame_count: 12 } });
        expect(result.kind).toBe('image_animated_unsupported');
        expect(result.imageFrameCount).toBe(12);
      });

      test('CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED(422) — aspect_ratio/max_aspect_ratio 보존', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED', message: '…', aspect_ratio: 12.5, max_aspect_ratio: 10.0 } });
        expect(result.kind).toBe('image_aspect_ratio_exceeded');
        expect(result.imageAspectRatio).toBe(12.5);
        expect(result.imageMaxAspectRatio).toBe(10.0);
      });

      test('CHANNEL_IMAGE_CONVERSION_FAILED(422) — final_bytes/max_bytes 보존', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_CONVERSION_FAILED', message: '…', final_bytes: 9000000, max_bytes: 8388608 } });
        expect(result.kind).toBe('image_conversion_failed');
        expect(result.imageFinalBytes).toBe(9000000);
        expect(result.imageMaxBytes).toBe(8388608);
      });

      test('CHANNEL_IMAGE_UPLOAD_FAILED(502) — 고정 문구', () => {
        const result = parseSitePostApiError({ error: { code: 'CHANNEL_IMAGE_UPLOAD_FAILED', message: '…' } });
        expect(result.kind).toBe('image_upload_failed');
        expect(result.humanMessageKey).toBe('errorChannelImageUploadFailed');
      });

      test('9종 전부 서로 다른 kind — unknown으로 조용히 안 떨어진다', () => {
        const codes = [
          'CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED', 'CHANNEL_IMAGE_UNSUPPORTED', 'CHANNEL_IMAGE_UNSUPPORTED_FORMAT',
          'CHANNEL_IMAGE_TOO_LARGE', 'CHANNEL_IMAGE_UNDECODABLE', 'CHANNEL_IMAGE_ANIMATED_UNSUPPORTED',
          'CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED', 'CHANNEL_IMAGE_CONVERSION_FAILED', 'CHANNEL_IMAGE_UPLOAD_FAILED',
        ];
        const kinds = codes.map((code) => parseSitePostApiError({ error: { code, message: '…' } }).kind);
        expect(new Set(kinds).size).toBe(9);
        expect(kinds).not.toContain('unknown');
      });
    });
  });
});
