import { describe, expect, it } from 'vitest';
import {
  EXEMPT_TARGETS,
  extractComposedTargets,
  extractLiteralTargets,
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
describe('AC7 — 실제 저장소 첫 스캔의 검거 2건(GRANDFATHER_BASELINE)이 진짜인지 확認', () => {
  it('mockups — [ws]/[proj]/mockups 라우트가 있고 KNOWN 진입점 목록엔 없다', () => {
    // app-sidebar.tsx/command-palette.tsx/more/page.tsx 어디에도 resourceLink('mockups')·
    // resourceHref('mockups')·literal '/mockups'가 없음을 실제 파일 3개로 확認(2026-08-01 grep 전수).
    const knownEntryOwnerSnippets = [
      `resourceLink('docs'); resourceLink('standup'); resourceLink('retro'); resourceLink('loops');
       resourceLink('artifacts'); resourceLink('sprints'); resourceLink('storage'); resourceLink('goals');
       resourceLink('flow');`, // app-sidebar.tsx 실제 호출 집합
      `href: '/inbox' href: '/dashboard' href: '/board' href: '/sprints' href: '/chats'
       resourceHref('docs') resourceHref('flow')`, // command-palette.tsx 실제 대상 집합
      `href: '/sprints' href: '/goals' href: '/loops' href: '/standup' href: '/retro'
       href: '/activity' href: '/docs' href: '/artifacts' href: '/storage' href: '/dashboard'
       href: '/settings'`, // more/page.tsx 실제 ITEMS 집합
    ].join('\n');
    const composed = extractComposedTargets(knownEntryOwnerSnippets);
    const literal = extractLiteralTargets(knownEntryOwnerSnippets);
    expect([...composed, ...literal]).not.toContain('mockups');
  });

  it('GRANDFATHER_BASELINE 크기는 정확히 2다(3번째부터는 PO 승인 없이 조용히 못 들어온다)', () => {
    expect(GRANDFATHER_BASELINE.size).toBe(2);
    expect(GRANDFATHER_BASELINE.has('routeWithoutEntry:mockups')).toBe(true);
    expect(GRANDFATHER_BASELINE.has('entryWithoutRoute:memos')).toBe(true);
  });
});

describe('EXEMPT_TARGETS — 실측 스냅샷 정합', () => {
  it('KNOWN_NON_PROJECT_ROUTES와 RENAMED_RESOURCE_ALIASES의 합집합이다', () => {
    expect(EXEMPT_TARGETS.size).toBe(KNOWN_NON_PROJECT_ROUTES.size + RENAMED_RESOURCE_ALIASES.size);
  });

  it('로그인 전 공개 라우트(최초 스캔 오탐의 원인)가 전부 등재돼 있다', () => {
    for (const r of ['login', 'register', 'forgot-password', 'privacy', 'terms', 'verify-email', 'onboarding']) {
      expect(KNOWN_NON_PROJECT_ROUTES.has(r)).toBe(true);
    }
  });
});
