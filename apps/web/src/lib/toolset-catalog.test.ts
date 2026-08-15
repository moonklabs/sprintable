// story #2661 — kitOrientingWakeBody 커버리지 pin(recruiter-client.test.tsx)과 동형: 새 그룹키가
// mcp_toolset.py(BE SSOT)나 TEMP_TOOLSET_CATALOG(FE 폴백)에 추가되고도 i18n 라벨이 안 따라오면
// tool-permission-picker.tsx가 `t('toolPermissions.groups.<key>')`를 콘솔 MISSING_MESSAGE와 함께
// 원시 키/폴백으로 그대로 노출한다(canvas·events가 실제로 이렇게 샜다). 소스 텍스트 매칭이 아니라
// ko/en 메시지 객체를 직접 인덱싱해 누락 시 이 테스트가 red로 고정한다.
import { describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { TEMP_TOOLSET_CATALOG } from './toolset-catalog';

// backend/app/services/mcp_toolset.py의 ALL_GROUPS(SSOT) — "admin"은 별도(ALL_GROUPS에서 제외되지만
// FE UI는 dangerTitle 섹션으로 자체 노출하므로 라벨은 여전히 필요) + "core"(_CORE, 항상 포함).
// 이 목록이 BE와 벌어지면(신규 그룹 추가) 이 테스트가 먼저 알아채도록 손으로 미러링한다 — 자동
// 동기화는 이 스토리 스코프 밖(별도 계약테스트 후보로 남긴다).
const BE_ALL_GROUPS = [
  'core', 'rewards', 'analytics', 'agent_runs', 'audit', 'webhooks', 'notifications',
  'meetings', 'retro', 'standup', 'docs', 'chat', 'sprints', 'hypotheses', 'epics',
  'tasks', 'stories', 'canvas', 'events', 'admin',
] as const;

type MessagesShape = { agents: { toolPermissions: { groups: Record<string, string> } } };

describe('toolPermissions.groups i18n 커버리지 (story #2661)', () => {
  it.each(BE_ALL_GROUPS)('그룹 "%s" — ko/en 라벨이 둘 다 존재하고 비어있지 않다', (key) => {
    const ko = (koMessages as MessagesShape).agents.toolPermissions.groups;
    const en = (enMessages as MessagesShape).agents.toolPermissions.groups;
    expect(ko[key], `ko.agents.toolPermissions.groups.${key}`).toBeTruthy();
    expect(en[key], `en.agents.toolPermissions.groups.${key}`).toBeTruthy();
  });

  it('TEMP_TOOLSET_CATALOG(FE 폴백)의 모든 group.key도 ko/en 라벨을 갖는다(BE 미준비/실패 시 화면)', () => {
    const ko = (koMessages as MessagesShape).agents.toolPermissions.groups;
    const en = (enMessages as MessagesShape).agents.toolPermissions.groups;
    for (const g of TEMP_TOOLSET_CATALOG.groups) {
      expect(ko[g.key], `ko.agents.toolPermissions.groups.${g.key}`).toBeTruthy();
      expect(en[g.key], `en.agents.toolPermissions.groups.${g.key}`).toBeTruthy();
    }
  });

  it('TEMP_TOOLSET_CATALOG이 canvas·events·hypotheses를 포함한다(BE ALL_GROUPS 드리프트 회귀가드)', () => {
    const keys = TEMP_TOOLSET_CATALOG.groups.map((g) => g.key);
    expect(keys).toContain('canvas');
    expect(keys).toContain('events');
    expect(keys).toContain('hypotheses');
  });
});
