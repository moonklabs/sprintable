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
});
