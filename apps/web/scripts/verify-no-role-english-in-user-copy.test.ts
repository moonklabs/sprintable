import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWLIST,
  computeViolations,
  flattenTargetNamespaces,
  loadKoJson,
  scanRoleSlugs,
  TARGET_NAMESPACES,
} from './verify-no-role-english-in-user-copy';

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');

describe('scanRoleSlugs — story #3894 셀프테스트', () => {
  // (a) POSITIVE CONTROL — 위반 값이 든 픽스처는 반드시 위반을 낸다(체커가 실제로 잡는다).
  it('⭐양성대조 — content 값 안 소문자 owner/admin → RED(슬러그마다 각각)', () => {
    const fixture = { content: { unpublishDisabledReason: 'owner/admin만 발행을 취소할 수 있어요.' } };
    const refs = scanRoleSlugs(fixture);
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.key === 'content.unpublishDisabledReason')).toBe(true);
    expect(refs.map((r) => r.slug).sort()).toEqual(['admin', 'owner']);
    // 픽스처엔 ALLOWLIST 키가 없으니 위반으로 남는다.
    expect(computeViolations(refs, ALLOWLIST)).toHaveLength(2);
  });

  it('⭐양성대조 — organization 합니다체 값(owner)도 잡힌다', () => {
    const fixture = { organization: { memberRoleChangeOwnerOnlyError: 'owner 권한이 필요한 작업입니다' } };
    const refs = scanRoleSlugs(fixture);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe('owner');
  });

  it('중첩 네임스페이스도 dot-path로 평탄화된다', () => {
    const fixture = { content: { group: { nested: 'admin만 가능해요.' } } };
    const refs = scanRoleSlugs(fixture);
    expect(refs[0]!.key).toBe('content.group.nested');
  });

  // 뮤테이션 대조 — 한국어 정본으로 옮기면 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — 한국어 정본(소유자·관리자)은 GREEN', () => {
    const fixture = { content: { unpublishDisabledReason: '소유자·관리자만 발행을 취소할 수 있어요.' } };
    expect(scanRoleSlugs(fixture)).toEqual([]);
  });

  it('음성대조 — 대문자(Owner)·부분문자열(coowner·administrator)은 GREEN(standalone lowercase only)', () => {
    const fixture = { content: { a: 'Owner 전용', b: 'coowner 배지', c: 'administrator 페이지' } };
    expect(scanRoleSlugs(fixture)).toEqual([]);
  });

  it('음성대조 — 대상 밖 네임스페이스(settings 등)의 owner/admin은 스캔 안 함', () => {
    const fixture = { settings: { memberRoleChangeOwnerOnlyError: 'owner 권한이 필요한 작업입니다' } };
    expect(scanRoleSlugs(fixture)).toEqual([]);
  });
});

describe('computeViolations — ALLOWLIST(placeholder 예시 슬러그)', () => {
  // (c) ALLOWLIST에 있는 placeholder 값은 owner/admin이 들어 있어도 위반이 아니다.
  it('⭐ALLOWLIST placeholder(예: owner, admin)는 위반 아님', () => {
    const fixture = {
      organization: {
        eventActionAuthRolePlaceholder: '발행 허용 역할(쉼표 구분, 선택) — 예: admin, owner',
        definerAuthRolesPlaceholder: '예: owner, admin',
      },
    };
    const refs = scanRoleSlugs(fixture);
    // scan은 슬러그를 찾지만(각 키 2개씩 = 4건)
    expect(refs.length).toBe(4);
    // computeViolations는 ALLOWLIST 키를 전부 걸러 0건.
    expect(computeViolations(refs, ALLOWLIST)).toEqual([]);
  });

  it('음성대조 — 같은 슬러그라도 ALLOWLIST 밖 키면 위반', () => {
    const fixture = { organization: { someOtherKey: '예: owner, admin' } };
    const refs = scanRoleSlugs(fixture);
    expect(computeViolations(refs, ALLOWLIST)).toHaveLength(2);
  });
});

describe('TARGET_NAMESPACES — 스코프 고정', () => {
  it('대상은 정확히 content·organization·pricingPlans·contentRules 4개', () => {
    expect([...TARGET_NAMESPACES].sort()).toEqual(['content', 'contentRules', 'organization', 'pricingPlans']);
  });
});

// (b) 실 트리 실행 — 이 PR의 치환 뒤 실 ko.json은 위반 0(ALLOWLIST 예외 제외).
describe('scanRoleSlugs — story #3894(실 트리 실행)', () => {
  it('실 ko.json — 대상 네임스페이스에서 위반 0(ALLOWLIST placeholder만 남고 전부 정본)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const flat = flattenTargetNamespaces(koJson);
    expect(flat.size).toBeGreaterThan(50);
    const refs = scanRoleSlugs(koJson);
    const violations = computeViolations(refs, ALLOWLIST);
    expect(violations).toEqual([]);
  });

  it('실 ko.json — ALLOWLIST 2키는 실제로 슬러그를 담고 있다(placeholder 예시가 살아 있음)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanRoleSlugs(koJson);
    for (const key of ALLOWLIST) {
      expect(refs.some((r) => r.key === key)).toBe(true);
    }
  });

  // 실 파일 뮤테이션 양성대조 — 이 PR에서 고친 자리를 원시 영어로 되돌리면 RED가 되는지
  // 실 ko.json으로 직접 확인(합성 표본 아님).
  it('실 파일 뮤테이션 — content.unpublishDisabledReason를 owner/admin로 되돌리면 RED', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const contentNs = koJson.content as Record<string, unknown>;
    expect(contentNs.unpublishDisabledReason).toBe('소유자·관리자만 발행을 취소할 수 있어요.');
    const mutated = {
      ...koJson,
      content: { ...contentNs, unpublishDisabledReason: 'owner/admin만 발행을 취소할 수 있어요.' },
    };
    const violations = computeViolations(scanRoleSlugs(mutated), ALLOWLIST);
    expect(violations.some((r) => r.key === 'content.unpublishDisabledReason')).toBe(true);
  });
});
