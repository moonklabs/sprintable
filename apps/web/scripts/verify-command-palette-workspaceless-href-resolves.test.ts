/**
 * story #4013 — command-palette.tsx의 GUARD_ANCHOR_ITEMS(작업 공간 없는 bare href,
 * 예: `/work-list`)가 실제로 `/{ws}/{proj}/...`로 해석되는지 검증한다.
 *
 * 근본원인: 기존 verify-no-orphan-resource-routes.ts(#2376)는 "진입점이 있다"·"라우트
 * 파일(`[ws]/[proj]/<resource>/page.tsx`)이 있다"만 대조한다 — proxy.ts가 그 사이를
 * 잇는 `legacy-resource-tables.ts`(MIGRATED_RESOURCES/RENAMED_RESOURCES)에 키가 있는지는
 * 안 본다. `work-list`가 정확히 이 사각(진입점 O·라우트 O·변환 표 키 X)이었다 — 404.
 *
 * 판정: GUARD_ANCHOR_ITEMS를 손 목록 없이 직접 import해 순회한다(AC2 "이름 목록
 * 하드코딩 X"). 각 href의 첫 세그먼트가 다음 중 하나면 PASS:
 *   ① MIGRATED_RESOURCES 키 — proxy.ts가 `/{ws}/{proj}/{segment}`로 해석.
 *   ② RENAMED_RESOURCES 키 — proxy.ts가 신 이름으로 301.
 *   ③ 작업 공간 자체가 필요 없는 실 최상위 페이지(`app/{segment}/page.tsx` 또는
 *     `app/(authenticated)/{segment}/page.tsx` 실존) — 지금 GUARD_ANCHOR_ITEMS엔
 *     해당 사례가 없지만(전부 project-scoped), 미래 항목을 위해 열어 둔다.
 *
 * 양성대조: MIGRATED_RESOURCES에서 임의 키 하나를 빼면(뮤테이션) 그 키를 쓰는
 * GUARD_ANCHOR_ITEMS 항목이 RED — `work-list`를 빼면 실제로 걸리는지 확인.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GUARD_ANCHOR_ITEMS } from '../src/components/command-palette/command-palette';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES } from '../src/lib/legacy-resource-tables';

const APP_DIR = path.resolve(__dirname, '..', 'src', 'app');

function firstSegment(href: string): string {
  const withoutQuery = href.split('?')[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`workspace-less href가 비어있다: ${href}`);
  }
  return segments[0];
}

function hasTopLevelPage(segment: string): boolean {
  return (
    fs.existsSync(path.join(APP_DIR, segment, 'page.tsx')) ||
    fs.existsSync(path.join(APP_DIR, '(authenticated)', segment, 'page.tsx'))
  );
}

function resolves(
  segment: string,
  migrated: Record<string, string[]>,
  renamed: Record<string, string>,
): boolean {
  return segment in migrated || segment in renamed || hasTopLevelPage(segment);
}

describe('command-palette GUARD_ANCHOR_ITEMS — workspace-less href가 실제로 해석되는가(story #4013)', () => {
  it('실 콜레션 — GUARD_ANCHOR_ITEMS가 비어있지 않다(가드가 헛돌지 않음을 보장)', () => {
    expect(GUARD_ANCHOR_ITEMS.length).toBeGreaterThan(0);
  });

  it.each(GUARD_ANCHOR_ITEMS.map((item) => [item.id, item.href] as const))(
    '%s(%s)가 MIGRATED_RESOURCES/RENAMED_RESOURCES 키이거나 실 최상위 페이지와 대응한다',
    (id, href) => {
      const segment = firstSegment(href);
      expect(
        resolves(segment, MIGRATED_RESOURCES, RENAMED_RESOURCES),
        `${id}(href=${href}) 첫 세그먼트 '${segment}'가 MIGRATED_RESOURCES/RENAMED_RESOURCES에 ` +
          `없고 실 최상위 page.tsx도 없다 — proxy.ts가 해석 못 해 404.`,
      ).toBe(true);
    },
  );

  it('양성대조 — MIGRATED_RESOURCES에서 work-list를 빼면 그 항목이 RED', () => {
    const withoutWorkList = { ...MIGRATED_RESOURCES };
    delete withoutWorkList['work-list'];
    const workListItem = GUARD_ANCHOR_ITEMS.find((item) => item.id === 'go-work-list');
    expect(workListItem).toBeDefined();
    const segment = firstSegment(workListItem!.href);
    expect(resolves(segment, withoutWorkList, RENAMED_RESOURCES)).toBe(false);
  });
});
