/**
 * story #4013 — command-palette.tsx가 실제로 렌더하는 **모든** 작업 공간 없는 href가
 * 해석되는지 검증한다.
 *
 * CHANGES①(페드루 PO 지적, 2026-09-17 12:52Z) — 최초판은 GUARD_ANCHOR_ITEMS(앵커 4개)만
 * 순회했다. 실제 navigate 목록은 그 4개 + NAV_GROUPS/LEGACY_NAV_ITEMS/CHAT_CENTER_ITEM
 * 파생분 중 `kind !== 'resource'`(정적, 워크스페이스 없는 절대경로, `organization/
 * channels`류)도 포함한다 — 그 파생분은 최초판 가드의 시야 밖이었다.
 *
 * CHANGES②(페드루 PO 지적, 2026-09-17 12:57Z) — CHANGES①의 `getWorkspacelessStaticNavItems()`
 * 는 컴포넌트의 실제 조립 코드(ITEMS useMemo)와 **다른** 코드로 같은 상수를 다시
 * 조립했다 — 상수만 같을 뿐 조립 로직이 두 곳이라 드리프트 위험이 여전했다.
 * `deriveNavigateItems(resolveResourceHref)` 하나로 통합해 컴포넌트 useMemo가 그 함수를
 * **호출**하고, 이 테스트도 같은 함수를 호출한 뒤 `isWorkspaceless`만 거른다 — 목록 조립
 * 코드 자체가 이제 정확히 한 곳(`deriveNavigateItems` 함수 본문)에만 있다(아래 grep
 * 테스트가 컴포넌트 useMemo 안에 그 조립이 재등장하지 않는지 고정).
 *
 * 판정은 두 축으로 나눈다:
 *   ① 변환 표(MIGRATED_RESOURCES/RENAMED_RESOURCES) — **첫 세그먼트**만(레거시 표 자체가
 *      1세그먼트 리소스명 키라 그렇다, `/work-list`류).
 *   ② 표에 없으면 **전체 경로**가 실 `page.tsx`(라우트 그룹 `(authenticated)` 포함)와
 *      대응하는지(`/organization/channels`류 — 여러 세그먼트라 첫 세그먼트만 보면 오판).
 *
 * `PARITY_TEST_DATABASE_URL`/`ALEMBIC_DATABASE_URL` 불요(순수 정적 스캔).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deriveNavigateItems } from '../src/components/command-palette/command-palette';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES } from '../src/lib/legacy-resource-tables';

const APP_DIR = path.resolve(__dirname, '..', 'src', 'app');
const COMMAND_PALETTE_SOURCE = path.resolve(
  __dirname, '..', 'src', 'components', 'command-palette', 'command-palette.tsx',
);

function firstSegment(href: string): string {
  const segments = href.split('?')[0].split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`workspace-less href가 비어있다: ${href}`);
  }
  return segments[0];
}

function hasFullPathPage(href: string): boolean {
  const segments = href.split('?')[0].split('/').filter(Boolean);
  const relPath = path.join(...segments, 'page.tsx');
  return (
    fs.existsSync(path.join(APP_DIR, relPath)) ||
    fs.existsSync(path.join(APP_DIR, '(authenticated)', relPath))
  );
}

function resolves(
  href: string,
  migrated: Record<string, string[]>,
  renamed: Record<string, string>,
): boolean {
  const segment = firstSegment(href);
  if (segment in migrated || segment in renamed) return true;
  return hasFullPathPage(href);
}

// 가드용 더미 — isWorkspaceless=true 항목은 이 콜백을 아예 안 부른다(deriveNavigateItems
// 본문 주석 참고) 그래서 어떤 값을 리턴해도 워크스페이스-없음 후보의 href엔 영향 없다.
const DUMMY_RESOLVE_RESOURCE_HREF = (resource: string) => `/DUMMY/${resource}`;

function workspacelessCandidates(): Array<{ id: string; href: string }> {
  return deriveNavigateItems(DUMMY_RESOLVE_RESOURCE_HREF)
    .filter((item) => item.isWorkspaceless)
    .map((item) => ({ id: item.id, href: item.href }));
}

describe('command-palette — 워크스페이스 없는 href 전부가 실제로 해석되는가(story #4013)', () => {
  it('실 콜렉션 — 후보가 비어있지 않고 앵커+정적 nav 파생분이 섞여 있다(가드가 헛돌지 않음)', () => {
    const candidates = workspacelessCandidates();
    expect(candidates.length).toBeGreaterThan(4); // 앵커 4개보다 많아야 정적 nav 파생분이 섞인 것.
  });

  it.each(workspacelessCandidates().map((item) => [item.id, item.href] as const))(
    '%s(%s)가 변환 표(첫 세그먼트) 또는 실 page.tsx(전체 경로)와 대응한다',
    (id, href) => {
      expect(
        resolves(href, MIGRATED_RESOURCES, RENAMED_RESOURCES),
        `${id}(href=${href})가 MIGRATED_RESOURCES/RENAMED_RESOURCES 키도 아니고 ` +
          `실 page.tsx(전체 경로)와도 대응하지 않는다 — 404.`,
      ).toBe(true);
    },
  );

  it('양성대조① — MIGRATED_RESOURCES에서 work-list를 빼면 flat `/work-list`가 RED', () => {
    // story #4274 — ⌘K 앵커(go-work-list 등)는 이제 `/{ws}/{proj}/{자원}` 직접 주소(resolveResourceHref)라 워크스페이스 없는 후보가 아니다.
    // 판정 함수 자체의 민감도는 같은 경로 문자열로 그대로 잰다.
    const withoutWorkList = { ...MIGRATED_RESOURCES };
    delete withoutWorkList['work-list'];
    expect(resolves('/work-list', MIGRATED_RESOURCES, RENAMED_RESOURCES)).toBe(true);
    expect(resolves('/work-list', withoutWorkList, RENAMED_RESOURCES)).toBe(false);
    expect(workspacelessCandidates().some((item) => item.id === 'go-work-list'), '앵커는 워크스페이스 없는 후보가 아님').toBe(false);
  });

  it('양성대조② — nav 파생 쪽에 없는(합성) 경로는 RED', () => {
    expect(resolves('/this-path-does-not-exist-story-4013', MIGRATED_RESOURCES, RENAMED_RESOURCES)).toBe(false);
  });

  it('여러 세그먼트 static nav 경로(예: /organization/channels)는 첫 세그먼트가 아니라 전체 경로로 판정된다', () => {
    // 'organization'은 MIGRATED_RESOURCES/RENAMED_RESOURCES 어디에도 없다(네임스페이스일
    // 뿐 리소스명이 아님) — 첫 세그먼트만 봤다면 이 경로는 항상 RED였을 것.
    expect('organization' in MIGRATED_RESOURCES).toBe(false);
    expect('organization' in RENAMED_RESOURCES).toBe(false);
    const orgChannelsItem = workspacelessCandidates().find((item) => item.href === '/organization/channels');
    expect(orgChannelsItem, 'org-channels가 nav-config.ts에서 이름이 바뀌었으면 이 테스트도 갱신').toBeDefined();
    expect(resolves(orgChannelsItem!.href, MIGRATED_RESOURCES, RENAMED_RESOURCES)).toBe(true);
  });

  it('CHANGES② 고정 — 컴포넌트 ITEMS useMemo 본문 안에는 NAV_GROUPS.flatMap 목록 조립이 없다(deriveNavigateItems 안에만 있어야 함)', () => {
    const source = fs.readFileSync(COMMAND_PALETTE_SOURCE, 'utf8');
    const itemsMemoStart = source.indexOf('const ITEMS = useMemo');
    expect(itemsMemoStart, 'ITEMS useMemo 선언 자체를 못 찾음 — 컴포넌트 구조가 바뀌었으면 이 테스트도 갱신').toBeGreaterThan(-1);
    const depsLineIdx = source.indexOf('}, [orgSlug, currentProjectSlug', itemsMemoStart);
    expect(depsLineIdx, 'ITEMS useMemo의 deps 배열 라인을 못 찾음').toBeGreaterThan(-1);
    const itemsMemoBody = source.slice(itemsMemoStart, depsLineIdx);
    expect(itemsMemoBody).not.toContain('NAV_GROUPS');
    expect(itemsMemoBody).not.toContain('.flatMap(');
    expect(itemsMemoBody).toContain('deriveNavigateItems(');

    // deriveNavigateItems 밖에 NAV_GROUPS.flatMap이 새로 생기지 않았는지도 전수 확認
    // (import 구문·주석 제외 — 실제 코드에서 정확히 1곳, 그 함수 본문 안이어야 한다).
    const deriveFnStart = source.indexOf('export function deriveNavigateItems');
    expect(deriveFnStart).toBeGreaterThan(-1);
    const realCodeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('import'));
    const flatMapLines = realCodeLines.filter((line) => line.includes('NAV_GROUPS.flatMap('));
    expect(flatMapLines).toHaveLength(1);
  });
});
