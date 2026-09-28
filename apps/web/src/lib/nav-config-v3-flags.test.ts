// story #4003(E-UX-OVERHAUL·셸 통합 2/N) — nav-config.ts::resolveNavGroups/
// resolveChatCenterItem이 nav-v3-destinations.ts 결정 함수를 실제로 적용하는지 잰다
// (그 모듈 자신의 표 테스트는 nav-v3-destinations.test.ts가 전담 — 여기선 "NAV_GROUPS
// 구조에 그 서술자가 제대로 꽂히는가"만).
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, CHAT_CENTER_ITEM, resolveNavGroups, resolveChatCenterItem } from './nav-config';
import { DEFAULT_NAV_V3_FLAGS } from './nav-v3-destinations';

function findItem(groups: ReturnType<typeof resolveNavGroups>, id: string) {
  for (const g of groups) {
    const item = g.items.find((i) => i.id === id);
    if (item) return item;
  }
  return undefined;
}

describe('resolveNavGroups — story #4003 AC2', () => {
  it('⭐전부 OFF — NAV_GROUPS와 바이트 동일(회귀 0 기준선, 「일감」의 path=flow도 포함)', () => {
    const resolved = resolveNavGroups(DEFAULT_NAV_V3_FLAGS);
    expect(resolved).toEqual(NAV_GROUPS);
    expect(findItem(resolved, 'board')?.path).toBe('flow');
  });

  it('todayV3Enabled — org-briefing 항목의 path만 /today로 바뀌고 나머지는 무변', () => {
    const resolved = resolveNavGroups({ ...DEFAULT_NAV_V3_FLAGS, todayV3Enabled: true });
    expect(findItem(resolved, 'org-briefing')?.path).toBe('/today');
    expect(findItem(resolved, 'org-channels')?.path).toBe('/organization/channels');
  });

  it('⭐임의 플래그 하나라도 ON — 「일감」(board) path가 work-list로(단일 플래그 의존 0)', () => {
    for (const flags of [
      { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false },
      { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false },
      { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true },
    ]) {
      expect(findItem(resolveNavGroups(flags), 'board')?.path).toBe('work-list');
    }
  });

  it('결과(org-insights-board) — 플래그 무관 고정 경로(분기 없음, 단일 소스가 명시적으로 씀)', () => {
    const resolved = resolveNavGroups({ todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true });
    expect(findItem(resolved, 'org-insights-board')?.path).toBe('/organization/insights-board');
  });

  it('connectRulesV3Enabled — connect-rules 그룹 맨 앞에 신규 항목이 추가되고 옛 3항목은 그대로 남는다(옛 진입점 유지)', () => {
    // story #4003 rebase(develop 대비, 2026-09-22) — org-generation-connectors가
    // 이 브랜치가 갈라진 뒤 nav-config.ts connect-rules 그룹에 새로 추가됐다(무관
    // 변경, 이 PR 스코프 밖) — 원본 NAV_GROUPS 상수와의 통짜 대조 원칙 그대로
    // 유지하며 기대값만 현재 develop 실제 순서로 갱신.
    const resolved = resolveNavGroups({ ...DEFAULT_NAV_V3_FLAGS, connectRulesV3Enabled: true });
    const group = resolved.find((g) => g.id === 'connect-rules');
    expect(group?.items.map((i) => i.id)).toEqual([
      'connect-rules-v3', 'org-channels', 'org-generation-connectors', 'org-content-rules',
    ]);
    expect(findItem(resolved, 'connect-rules-v3')?.path).toBe('/connect-rules');
  });

  it('connectRulesV3Enabled=false — connect-rules 그룹엔 옛 3항목만(신규 항목 노출 0)', () => {
    const resolved = resolveNavGroups(DEFAULT_NAV_V3_FLAGS);
    const group = resolved.find((g) => g.id === 'connect-rules');
    expect(group?.items.map((i) => i.id)).toEqual(['org-channels', 'org-generation-connectors', 'org-content-rules']);
  });

  it('⭐전부 ON — 항목 전체 신 경로 동시 적용(교차 오염 0)', () => {
    const resolved = resolveNavGroups({ todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true });
    expect(findItem(resolved, 'org-briefing')?.path).toBe('/today');
    expect(findItem(resolved, 'board')?.path).toBe('work-list');
    expect(findItem(resolved, 'connect-rules-v3')?.path).toBe('/connect-rules');
  });
});

describe('resolveChatCenterItem — story #4003 AC2', () => {
  it('⭐OFF — CHAT_CENTER_ITEM과 바이트 동일', () => {
    expect(resolveChatCenterItem(DEFAULT_NAV_V3_FLAGS)).toEqual(CHAT_CENTER_ITEM);
  });

  it('chatV3Enabled — path만 /chat으로, 라벨·아이콘·배지는 무변', () => {
    const resolved = resolveChatCenterItem({ ...DEFAULT_NAV_V3_FLAGS, chatV3Enabled: true });
    expect(resolved.path).toBe('/chat');
    expect(resolved.labelKey).toBe(CHAT_CENTER_ITEM.labelKey);
    expect(resolved.badgeKey).toBe(CHAT_CENTER_ITEM.badgeKey);
  });
});
