// story #2858(loop-closure P2, BE PR#3274) — parseLoopQueuePage/deriveLoopQueueItems 순수
// 파싱·파생 검증. cross-project href/label 규율은 #2842 export분(derive-attention-clusters.ts)을
// 그대로 재사용하므로 여기서는 그 재사용이 정확히 배선됐는지만 확認한다(로직 자체 재검증 X).
import { describe, expect, it } from 'vitest';
import {
  parseLoopQueuePage, parseProjectSlugMap, deriveLoopQueueItems,
  type RawLoopQueueItem,
} from './derive-loop-queue';

const t = (key: string) => key;

function raw(overrides: Partial<RawLoopQueueItem>): RawLoopQueueItem {
  return {
    work_item_type: 'hypothesis', work_item_id: 'h1', title: 'X',
    owner_member_id: null, overdue_days: 3, reason: 'measure_after_overdue', project_id: null,
    ...overrides,
  };
}

describe('parseLoopQueuePage', () => {
  it('items·total·limit·offset을 그대로 옮긴다', () => {
    const page = parseLoopQueuePage({
      items: [{ work_item_type: 'hypothesis', work_item_id: 'h1', title: 'X', owner_member_id: null, overdue_days: 3, reason: 'measure_after_overdue', project_id: null }],
      total: 96, limit: 25, offset: 0,
    });
    expect(page.items).toHaveLength(1);
    expect(page).toMatchObject({ total: 96, limit: 25, offset: 0 });
  });

  it('work_item_type/work_item_id 없는 항목은 생략한다(no-fiction)', () => {
    const page = parseLoopQueuePage({ items: [{ title: 'X' }], total: 1, limit: 25, offset: 0 });
    expect(page.items).toHaveLength(0);
  });

  it('total이 0이어도(falsy) items.length로 덮이지 않는다(회귀 가드 — ?? vs && 버그류)', () => {
    const page = parseLoopQueuePage({ items: [], total: 0, limit: 25, offset: 0 });
    expect(page.total).toBe(0);
  });

  it('형상이 어긋나면 빈 페이지를 낸다(throw 0)', () => {
    expect(parseLoopQueuePage(null).items).toEqual([]);
    expect(parseLoopQueuePage({}).items).toEqual([]);
  });
});

describe('parseProjectSlugMap', () => {
  it('id/slug 목록을 id→slug 맵으로 접는다', () => {
    const map = parseProjectSlugMap([{ id: 'p1', slug: 'sprintable' }, { id: 'p2', slug: 'zero-go' }]);
    expect(map).toEqual({ p1: 'sprintable', p2: 'zero-go' });
  });

  it('slug 없는(legacy) 프로젝트는 생략한다', () => {
    const map = parseProjectSlugMap([{ id: 'p1', slug: null }]);
    expect(map).toEqual({});
  });
});

describe('deriveLoopQueueItems', () => {
  it('hypothesis→overdueHypothesis, epic+measure_after_overdue→overdueGoal, epic+done_without_outcome→outcomeMissing', () => {
    const items = deriveLoopQueueItems([
      raw({ work_item_type: 'hypothesis', work_item_id: 'h1' }),
      raw({ work_item_type: 'epic', work_item_id: 'g1', reason: 'measure_after_overdue' }),
      raw({ work_item_type: 'epic', work_item_id: 'g2', reason: 'done_without_outcome', overdue_days: null }),
    ], t);
    expect(items.map((i) => i.kind)).toEqual(['overdueHypothesis', 'overdueGoal', 'outcomeMissing']);
  });

  it('reason이 계약 밖(null 등)이면 행을 만들지 않는다(no-fiction)', () => {
    const items = deriveLoopQueueItems([raw({ work_item_type: 'epic', reason: null })], t);
    expect(items).toHaveLength(0);
  });

  // story #2842 규율 승계(AC5) — viewer+projectSlugById 제공 시 href가 소속 프로젝트 slug로,
  // 다른 프로젝트면 crossProjectLabel이 채워진다.
  it('projectSlugById로 project_id를 slug로 해소해 href를 짓고 cross-project를 병기한다', () => {
    const items = deriveLoopQueueItems(
      [raw({ work_item_type: 'hypothesis', work_item_id: 'h1', project_id: 'p-other' })],
      t,
      { orgSlug: 'moonklabs', activeProjectId: 'p-active' },
      { 'p-other': 'other-proj' },
    );
    expect(items[0]!.href).toBe('/moonklabs/other-proj/flow?hypothesis=h1');
    expect(items[0]!.crossProjectLabel).toBe('other-proj');
  });

  it('slug 맵에 없는 project_id는 bare path로 폴백한다(지어내지 않음)', () => {
    const items = deriveLoopQueueItems(
      [raw({ work_item_type: 'epic', work_item_id: 'g1', reason: 'measure_after_overdue', project_id: 'p-unknown' })],
      t,
      { orgSlug: 'moonklabs', activeProjectId: 'p-active' },
      {},
    );
    expect(items[0]!.href).toBe('/flow?view=flow&goal=g1');
    expect(items[0]!.crossProjectLabel).toBeNull();
  });

  it('viewer 미제공(구 호출부)이면 bare path로 폴백한다(회귀 0)', () => {
    const items = deriveLoopQueueItems([raw({ work_item_type: 'hypothesis', work_item_id: 'h1' })], t);
    expect(items[0]!.href).toBe('/flow?hypothesis=h1');
  });

  it('title이 없으면 폴백 문구를 쓴다(no-fiction)', () => {
    const items = deriveLoopQueueItems([raw({ title: null })], t);
    expect(items[0]!.title).toBe('loopQueueUntitled');
  });
});
