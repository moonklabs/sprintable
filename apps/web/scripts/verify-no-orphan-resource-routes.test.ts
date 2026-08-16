import { describe, expect, it } from 'vitest';
import { RENAMED_RESOURCES, RETIRED_RESOURCES } from '../src/proxy';
import {
  EXEMPT_TARGETS,
  extractComposedTargets,
  extractLiteralTargets,
  extractNavConfigResourceTargets,
  findEntryWithoutRoute,
  findRouteWithoutEntry,
  GRANDFATHER_BASELINE,
  KNOWN_NON_PROJECT_ROUTES,
  RENAMED_RESOURCE_ALIASES,
  type EntryHit,
} from './verify-no-orphan-resource-routes';

describe('extractComposedTargets — AC2㉠', () => {
  it('resourceLink(\'x\')·resourceHref(\'x\') 둘 다 뽑는다', () => {
    const src = `
      const flowLink = resourceLink('flow');
      const docsHref = resourceHref('docs');
    `;
    expect(extractComposedTargets(src)).toEqual(['flow', 'docs']);
  });

  it('변수 인자(런타임 조립)는 못 뽑는다(AC7㉠ — 리터럴만 본다)', () => {
    expect(extractComposedTargets(`resourceLink(someVar)`)).toEqual([]);
  });
});

// story #2681/#2682 후속 — app-sidebar.tsx·more/page.tsx가 resourceLink('x') 리터럴 반복을
// nav-config.ts(NAV_GROUPS) 순회로 리팩터하며 resourceLink(item.path)(변수 인자)가 됐다.
// 이 가드가 원래 리터럴만 보므로(AC7㉠), nav-config.ts의 `kind: 'resource', path: 'x'` 짝을
// 새 진입점 축으로 인정해야 리팩터가 "조용한 도달불가"(routeWithoutEntry)로 오판되지 않는다.
describe('extractNavConfigResourceTargets — nav-config.ts SSOT 축(story #2681/#2682 후속)', () => {
  it('kind: \'resource\', path: \'x\' 짝을 뽑는다', () => {
    const src = `
      { id: 'flow', labelKey: 'flow', icon: Workflow, kind: 'resource', path: 'flow', kbdHint: 'B' },
      { id: 'docs', labelKey: 'docs', icon: BookOpen, kind: 'resource', path: 'docs' },
    `;
    expect(extractNavConfigResourceTargets(src)).toEqual(['flow', 'docs']);
  });

  it('kind: \'static\'인 항목은 안 뽑는다(resource 축만)', () => {
    const src = `{ id: 'org-events', labelKey: 'orgEvents', icon: Zap, kind: 'static', path: '/organization/events' },`;
    expect(extractNavConfigResourceTargets(src)).toEqual([]);
  });
});

describe('extractLiteralTargets — AC2㉡', () => {
  it('href="/x" (JSX)와 href: \'/x\' (객체 리터럴) 둘 다 뽑는다', () => {
    const src = `
      <Link href="/sprints" />
      const item = { href: '/goals' };
    `;
    expect(extractLiteralTargets(src)).toEqual(['sprints', 'goals']);
  });

  it('쿼리스트링이 붙어도 리소스 이름만 뽑는다(more/page.tsx·mobile-tab-bar.tsx류)', () => {
    expect(extractLiteralTargets(`href: '/inbox?tab=gates'`)).toEqual(['inbox']);
  });

  it('세그먼트가 2개 이상이면 안 뽑는다(AC7㉡ — 엔티티 상세·organization/** 등은 스코프 밖)', () => {
    expect(extractLiteralTargets(`href="/organization/workforce"`)).toEqual([]);
    expect(extractLiteralTargets(`href="/mockups/abc123"`)).toEqual([]);
  });

  it('템플릿 리터럴도 뽑는다 — 쿼리 부분의 보간(${x})은 허용(onboarding 케이스, 실측)', () => {
    expect(extractLiteralTargets('window.location.href = `/onboarding?step=project&orgId=${orgId}`;')).toEqual([
      'onboarding',
    ]);
  });
});

describe('findEntryWithoutRoute — AC3 (진입점>0 & 라우트=0)', () => {
  const routeDirs = new Set(['flow', 'docs']);

  it('exempt·route 어디에도 없는 target만 잡는다', () => {
    const hits: EntryHit[] = [
      { target: 'flow', file: 'a.tsx', kind: 'composed' },
      { target: 'dashboard', file: 'b.tsx', kind: 'literal' },
      { target: 'ghost', file: 'c.tsx', kind: 'literal' },
    ];
    const result = findEntryWithoutRoute(hits, routeDirs, new Set(['dashboard']));
    expect([...result.keys()]).toEqual(['ghost']);
  });
});

describe('findRouteWithoutEntry — AC3 (진입점=0 & 라우트>0, 더 조용한 쪽)', () => {
  it('어떤 hit도 가리키지 않는 라우트 디렉터리를 잡는다', () => {
    const hits: EntryHit[] = [{ target: 'flow', file: 'a.tsx', kind: 'composed' }];
    expect(findRouteWithoutEntry(['flow', 'orphan'], hits)).toEqual(['orphan']);
  });

  it('전부 짝이 맞으면 빈 배열(과잉살상 아님)', () => {
    const hits: EntryHit[] = [
      { target: 'flow', file: 'a.tsx', kind: 'composed' },
      { target: 'docs', file: 'b.tsx', kind: 'literal' },
    ];
    expect(findRouteWithoutEntry(['flow', 'docs'], hits)).toEqual([]);
  });
});

// AC4 — 네 방향 mutation. 실제 CLI 실행(파일시스템 mutation)으로도 넷 다 확인했다(PR 설명의
// mutation 로그 참조 — __mutation_composed.ts/__mutation_literal.ts/zzzmutationtest 생성→
// 실행→삭제, 커밋 없음). 여기서는 같은 판정 함수를 단위테스트로 고정해 회귀를 막는다.
describe('AC4 — 네 방향 mutation (단위테스트 고정)', () => {
  it('①조합 깨기 — resourceLink(\'없는것\')이 entryWithoutRoute로 잡힌다', () => {
    const targets = extractComposedTargets(`resourceLink('doesnotexist999')`);
    const hits: EntryHit[] = targets.map((target) => ({ target, file: 'x.ts', kind: 'composed' }));
    const result = findEntryWithoutRoute(hits, new Set(['flow']), EXEMPT_TARGETS);
    expect(result.has('doesnotexist999')).toBe(true);
  });

  it('②리터럴 깨기 — href: \'/없는것\'이 entryWithoutRoute로 잡힌다', () => {
    const targets = extractLiteralTargets(`href: '/doesnotexist888'`);
    const hits: EntryHit[] = targets.map((target) => ({ target, file: 'x.ts', kind: 'literal' }));
    const result = findEntryWithoutRoute(hits, new Set(['flow']), EXEMPT_TARGETS);
    expect(result.has('doesnotexist888')).toBe(true);
  });

  it('③역방향 — 라우트만 있고 진입점을 전부 제거하면 routeWithoutEntry로 잡힌다', () => {
    const hits: EntryHit[] = [{ target: 'flow', file: 'a.tsx', kind: 'composed' }];
    expect(findRouteWithoutEntry(['flow', 'orphanroute'], hits)).toEqual(['orphanroute']);
  });

  it('④정상 — 짝이 맞는 리소스는 과잉살상 없이 초록(양쪽 다 0건)', () => {
    const hits: EntryHit[] = [
      { target: 'flow', file: 'a.tsx', kind: 'composed' },
      { target: 'docs', file: 'b.tsx', kind: 'literal' },
    ];
    const routeDirs = new Set(['flow', 'docs']);
    expect(findEntryWithoutRoute(hits, routeDirs, EXEMPT_TARGETS).size).toBe(0);
    expect(findRouteWithoutEntry(['flow', 'docs'], hits)).toEqual([]);
  });
});

// AC7 — 실제 저장소의 첫 검거를 재현한다(지어낸 픽스처가 아니라 실제 파일 경로로).
describe('AC7 — 실제 저장소 첫 스캔의 검거(GRANDFATHER_BASELINE)이 진짜인지 확認', () => {
  // story #2378(2026-08-01) — routeWithoutEntry:mockups는 실제로 고쳐져(라우트 자체를
  // 제거 + proxy.ts RENAMED_RESOURCES로 도착지 이관) baseline에서 빠졌다. story #2379가
  // entryWithoutRoute:memos를 먼저 뺐던 것과 같은 자리 — 이제 둘 다 빠져 Set이 빈다.
  it('GRANDFATHER_BASELINE 크기는 정확히 0이다(둘 다 고쳐졌다 — 새 항목은 PO 승인 없이 조용히 못 들어온다)', () => {
    expect(GRANDFATHER_BASELINE.size).toBe(0);
    expect(GRANDFATHER_BASELINE.has('routeWithoutEntry:mockups')).toBe(false);
    expect(GRANDFATHER_BASELINE.has('entryWithoutRoute:memos')).toBe(false);
  });
});

describe('EXEMPT_TARGETS — 파생 정합(story #2387)', () => {
  it('KNOWN_NON_PROJECT_ROUTES와 RENAMED_RESOURCE_ALIASES의 합집합이다', () => {
    expect(EXEMPT_TARGETS.size).toBe(KNOWN_NON_PROJECT_ROUTES.size + RENAMED_RESOURCE_ALIASES.size);
  });

  it('로그인 전 공개 라우트(최초 스캔 오탐의 원인)가 전부 등재돼 있다', () => {
    for (const r of ['login', 'register', 'forgot-password', 'privacy', 'terms', 'verify-email', 'onboarding']) {
      expect(KNOWN_NON_PROJECT_ROUTES.has(r)).toBe(true);
    }
  });
});

// story #2387 — RENAMED_RESOURCE_ALIASES는 이제 손 스냅샷이 아니라 proxy.ts를 직접 import해
// 파생시킨다(AC1: 「어긋나는 길이 없어지는」 쪽). 아래는 그 파생이 실제로 두 표 모두를 보는지
// 고정하는 회귀가드 — proxy.ts에 세 번째 키가 추가돼도(RENAMED_RESOURCES든 RETIRED_RESOURCES든)
// 이 테스트가 같은 소스에서 다시 계산하므로 자동으로 통과한다. 실제 "proxy.ts가 바뀌면 자동
// 반영되는가"는 CLI 뮤테이션으로 확인했다(PR 설명 — proxy.ts에 임시 키 추가 → 가드 재실행 →
// exempt 수가 32로 늘어남(31→32) 확認 → 원복 → 31로 복귀. 커밋 없음).
describe('RENAMED_RESOURCE_ALIASES — proxy.ts에서 실제로 파생되는지(AC1/AC2)', () => {
  it('RENAMED_RESOURCES ∪ RETIRED_RESOURCES 키와 정확히 같다(같은 소스에서 다시 계산해도 일치)', () => {
    const expected = new Set([...Object.keys(RENAMED_RESOURCES), ...Object.keys(RETIRED_RESOURCES)]);
    expect(RENAMED_RESOURCE_ALIASES).toEqual(expected);
  });

  it('rename 축(id 보존)과 retire 축(id 폐기)이 겹치지 않는다(중복 키가 있으면 그 자체가 축 혼동)', () => {
    const renameKeys = new Set(Object.keys(RENAMED_RESOURCES));
    const retireKeys = new Set(Object.keys(RETIRED_RESOURCES));
    const overlap = [...renameKeys].filter((k) => retireKeys.has(k));
    expect(overlap).toEqual([]);
  });

  it('mockups는 RETIRED_RESOURCES 쪽이다(story #2378 리뷰가 잡은 그 축 혼동의 정답 확인)', () => {
    expect(Object.keys(RETIRED_RESOURCES)).toContain('mockups');
    expect(Object.keys(RENAMED_RESOURCES)).not.toContain('mockups');
  });
});
