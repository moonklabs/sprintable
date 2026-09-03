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
  // 되돌릴 행동이 갈래마다 다르다(기다린다/권한 요청/재상신). kind 4칸 표.
  test('⭐kind 4칸 — 승인 미완료(approval_required)·권한 없음(permission)·재승인 필요(reapproval_required)·모름(unknown)이 서로 다른 kind로 갈린다', () => {
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

    const unknown = parseSitePostApiError({ detail: { code: 'SOME_FUTURE_CODE', message: '모름' } });
    expect(unknown.kind).toBe('unknown');

    // 넷 다 서로 다른 값 — 하나로 뭉쳐지지 않는다(§8-3④-1 핵심).
    const kinds = new Set([approvalRequired.kind, permission.kind, reapprovalRequired.kind, unknown.kind]);
    expect(kinds.size).toBe(4);
  });

  test('오늘(S3 착지 前) — EXTERNAL_PUBLISH_APPROVAL_REQUIRED는 아직 구조화 code가 아니라 평문 문자열이라 kind=unknown으로 안전하게 떨어진다', () => {
    // site_posts.py::ExternalPublishGateNotApprovedError는 지금 detail=str(exc)로 평문을
    // 낸다(code 필드 자체가 없다) — 이 테스트는 그 실물과의 괴리를 회귀로 고정한다.
    const result = parseSitePostApiError({ detail: 'external_publish 게이트가 승인되지 않았습니다(gate_id=g1, status=pending)' });
    expect(result.kind).toBe('unknown');
    expect(result.humanMessageFallback).toContain('gate_id=g1');
  });
});
