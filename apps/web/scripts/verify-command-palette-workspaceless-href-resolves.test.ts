/**
 * story #4013 — command-palette.tsx가 실제로 렌더하는 **모든** 작업 공간 없는 href가
 * 해석되는지 검증한다.
 *
 * CHANGES(페드루 PO 지적, 2026-09-17 12:52Z) — 최초판은 GUARD_ANCHOR_ITEMS(앵커 4개)만
 * 순회했다. 팔레트의 실제 navigate 목록은 그 4개 + NAV_GROUPS/LEGACY_NAV_ITEMS/
 * CHAT_CENTER_ITEM 파생분 중 `kind !== 'resource'`(정적, 워크스페이스 없는 절대경로)
 * 도 포함한다(`organization/channels`류) — 그 파생분은 최초판 가드의 시야 밖이었다.
 * `getWorkspacelessStaticNavItems()`(command-palette.tsx export, ITEMS useMemo와 같은
 * 소스·같은 필터 규칙)로 손 목록 없이 그 전부를 얻는다.
 *
 * 판정도 두 축으로 나눈다:
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
import { GUARD_ANCHOR_ITEMS, getWorkspacelessStaticNavItems } from '../src/components/command-palette/command-palette';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES } from '../src/lib/legacy-resource-tables';

const APP_DIR = path.resolve(__dirname, '..', 'src', 'app');

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

function allWorkspacelessCandidates(): Array<{ id: string; href: string }> {
  return [...GUARD_ANCHOR_ITEMS.map((item) => ({ id: item.id, href: item.href })), ...getWorkspacelessStaticNavItems()];
}

describe('command-palette — 워크스페이스 없는 href 전부가 실제로 해석되는가(story #4013)', () => {
  it('실 콜렉션 — 후보가 비어있지 않고, 앵커 4개+정적 nav 파생분이 섞여 있다(가드가 헛돌지 않음)', () => {
    const candidates = allWorkspacelessCandidates();
    expect(candidates.length).toBeGreaterThan(GUARD_ANCHOR_ITEMS.length);
  });

  it.each(allWorkspacelessCandidates().map((item) => [item.id, item.href] as const))(
    '%s(%s)가 변환 표(첫 세그먼트) 또는 실 page.tsx(전체 경로)와 대응한다',
    (id, href) => {
      expect(
        resolves(href, MIGRATED_RESOURCES, RENAMED_RESOURCES),
        `${id}(href=${href})가 MIGRATED_RESOURCES/RENAMED_RESOURCES 키도 아니고 ` +
          `실 page.tsx(전체 경로)와도 대응하지 않는다 — 404.`,
      ).toBe(true);
    },
  );

  it('양성대조① — MIGRATED_RESOURCES에서 work-list를 빼면 그 앵커 항목이 RED', () => {
    const withoutWorkList = { ...MIGRATED_RESOURCES };
    delete withoutWorkList['work-list'];
    const workListItem = GUARD_ANCHOR_ITEMS.find((item) => item.id === 'go-work-list');
    expect(workListItem).toBeDefined();
    expect(resolves(workListItem!.href, withoutWorkList, RENAMED_RESOURCES)).toBe(false);
  });

  it('양성대조② — nav 파생 쪽에 없는(합성) 경로는 RED', () => {
    expect(resolves('/this-path-does-not-exist-story-4013', MIGRATED_RESOURCES, RENAMED_RESOURCES)).toBe(false);
  });

  it('여러 세그먼트 static nav 경로(예: /organization/channels)는 첫 세그먼트가 아니라 전체 경로로 판정된다', () => {
    // 'organization'은 MIGRATED_RESOURCES/RENAMED_RESOURCES 어디에도 없다(네임스페이스일
    // 뿐 리소스명이 아님) — 첫 세그먼트만 봤다면 이 경로는 항상 RED였을 것.
    expect('organization' in MIGRATED_RESOURCES).toBe(false);
    expect('organization' in RENAMED_RESOURCES).toBe(false);
    const orgChannelsItem = getWorkspacelessStaticNavItems().find((item) => item.href === '/organization/channels');
    expect(orgChannelsItem, 'org-channels가 nav-config.ts에서 이름이 바뀌었으면 이 테스트도 갱신').toBeDefined();
    expect(resolves(orgChannelsItem!.href, MIGRATED_RESOURCES, RENAMED_RESOURCES)).toBe(true);
  });
});
