// story #1991(navigate 불안정 1차 근원 B) — 하단 4탭 active 판정 회귀가드. 기존 isTabActive는
// 4탭 href 자체+직계 하위만 인식해 gate/doc/story 상세·프로젝트/org 영역(board/goals/loops/
// organization/settings 등, #1958 "전체" 스텁 목록 그대로)이 전부 회색이었다. getActiveTabKey가
// #1951 매니페스트 SSOT(상세→parentTab)를 그대로 재사용해 정확히 판정하는지 고정.
import { describe, expect, it } from 'vitest';
import { getActiveTabKey, TABS } from './mobile-tab-bar';

describe('getActiveTabKey', () => {
  it('/{ws}/{proj}/flow 및 하위 경로는 now — story #2224, "지금" 탭의 새 목적지', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow')).toBe('now');
    expect(getActiveTabKey('/qa-org/qa-proj/flow/anything')).toBe('now');
  });

  it('bare /flow(+하위)도 now — 결함 fix(선생님 실측 2026-07-30): TABS.now.href 자체가 bare라 탭을 누른 순간(proxy.ts 301 착지 前)엔 pathname이 이 형태다', () => {
    expect(getActiveTabKey('/flow')).toBe('now');
    expect(getActiveTabKey('/flow/anything')).toBe('now');
  });

  it('/glance 및 하위 경로도 계속 now(옛 라우트 — 리다이렉트 경유 도착 대비)', () => {
    expect(getActiveTabKey('/glance')).toBe('now');
    expect(getActiveTabKey('/glance/foo')).toBe('now');
  });

  it('/inbox 정확일치는 approvals', () => {
    expect(getActiveTabKey('/inbox')).toBe('approvals');
  });

  it('게이트 canonical 상세(/gates/{id})는 approvals — #1951 parentTab=/inbox 매핑 그대로', () => {
    expect(getActiveTabKey('/gates/7d0fc67b-d6c2-4767-a156-1bcf7c786ad0')).toBe('approvals');
  });

  it('/chats 및 대화 상세(/chats/{id})는 chat', () => {
    expect(getActiveTabKey('/chats')).toBe('chat');
    expect(getActiveTabKey('/chats/abc123')).toBe('chat');
  });

  it('프로젝트/org 영역(board·goals·loops·organization·settings 등)은 more — #1958 "전체" 스텁 목록과 정합', () => {
    expect(getActiveTabKey('/board')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/board')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/goals/abc')).toBe('more');
    expect(getActiveTabKey('/qa-org/qa-proj/loops/abc')).toBe('more');
    expect(getActiveTabKey('/organization/workforce/abc')).toBe('more');
    expect(getActiveTabKey('/settings')).toBe('more');
  });

  it('문서 상세(/{ws}/{proj}/docs/[slug])는 more — #1951 parentTab=/more 매핑과 정합', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/docs/my-doc')).toBe('more');
  });

  it('/more 자기 자신도 more', () => {
    expect(getActiveTabKey('/more')).toBe('more');
  });
});

// story #2279(PO 판정, 2026-07-29): 라벨("결재")·배지(게이트 대기 수)·착지(href)가 한 줄로
// 서야 한다 — bare `/inbox`(알림 탭 착지)로 되돌아가면 라벨과 다시 어긋난다.
describe('TABS — story #2279 회귀가드', () => {
  it('approvals 탭은 게이트 탭(/inbox?tab=gates)에 착지한다 — 알림 탭(bare /inbox)이 아니다', () => {
    const approvalsTab = TABS.find((t) => t.key === 'approvals');
    expect(approvalsTab?.href).toBe('/inbox?tab=gates');
  });

  it('now 탭은 /flow에 착지한다 — story #2224, 옛 /glance(삭제됨)로 조용히 되돌아가지 않는다', () => {
    const nowTab = TABS.find((t) => t.key === 'now');
    expect(nowTab?.href).toBe('/flow');
  });

  // 선생님 지적(2026-07-30) — 위 두 시험(href 값 하드코딩 + getActiveTabKey 값 하드코딩)은
  // 각자 맞아도 "서로 안 만나서" 어긋날 수 있다(isFlowPath가 3-세그먼트만 인식하고 TABS의
  // now.href가 bare였던 실제 사례). 탭 자신의 href를 판정기에 직접 먹이는 왕복 시험으로
  // 고정 — href를 나중에 또 바꿔도 이 시험이 자동으로 재검증한다(값을 또 하드코딩하지 않음).
  it('각 탭의 href는 getActiveTabKey를 다시 먹였을 때 자기 자신의 key로 돌아온다 — 왕복 회귀가드', () => {
    // usePathname()은 쿼리스트링을 안 싣는다(Next.js가 pathname/searchParams를 분리) — 실
    // 런타임과 같은 입력을 주기 위해 href의 쿼리 부분을 떼고 pathname만 넣는다(approvals
    // 탭의 `/inbox?tab=gates`가 대상).
    for (const tab of TABS) {
      const pathnameOnly = tab.href.split('?')[0]!;
      expect(getActiveTabKey(pathnameOnly)).toBe(tab.key);
    }
  });
});
