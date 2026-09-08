import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './nav-config';

// story #9c5e82dc(IA·S3, PO 確定 2026-09-08) — 새 자: 「프로젝트 전환 시 내용이 바뀌는
// 항목」 대 「화면이 그렇다고 말하는 항목」 8:0→8:8(3600 문서 원안)이었으나, activity가
// kind:'static'인데도 project_id로 실제 필터되는 것을 코드로 확認해 9:9로 정정됐다
// (doc의 「실측」은 구현 前 추정 — 라이브 코드가 정본).
const PROJECT_SCOPED_IDS = ['board', 'goals', 'loops', 'standup', 'retro', 'docs', 'artifacts', 'storage', 'activity'];
// 애매(표식 없음) — scope 필드를 아예 안 쓴다. inbox=순수 개인 알림(project/org 필터 0),
// settings=계정 설정인데 팀원 탭 하나만 project라 섞인 화면.
const AMBIGUOUS_IDS = ['inbox', 'settings'];

function allItems() {
  return NAV_GROUPS.flatMap((g) => g.items);
}

describe('NAV_GROUPS scope — story #9c5e82dc(IA·S3 AC1)', () => {
  it('항목 24개 전부가 scope 분류 대상이다(회귀 시 이 수부터 어긋난다)', () => {
    expect(allItems()).toHaveLength(24);
  });

  it('project 스코프 9항목이 정확히 이 집합이다(8→9, activity 포함)', () => {
    const projectIds = allItems().filter((i) => i.scope === 'project').map((i) => i.id).sort();
    expect(projectIds).toEqual([...PROJECT_SCOPED_IDS].sort());
  });

  it('org 스코프 13항목 — project·애매를 뺀 나머지 전부', () => {
    const orgIds = allItems().filter((i) => i.scope === 'org').map((i) => i.id).sort();
    const expected = allItems()
      .map((i) => i.id)
      .filter((id) => !PROJECT_SCOPED_IDS.includes(id) && !AMBIGUOUS_IDS.includes(id))
      .sort();
    expect(orgIds).toEqual(expected);
    expect(orgIds).toHaveLength(13);
  });

  it('애매 2항목(inbox·settings)은 scope 필드 자체가 없다(undefined — org로 기본값 안 깖)', () => {
    for (const id of AMBIGUOUS_IDS) {
      const item = allItems().find((i) => i.id === id);
      expect(item?.scope, `${id}.scope`).toBeUndefined();
    }
  });

  it('kind:"resource" 항목(8개)은 전부 project 스코프다(라우트 자체가 /{ws}/{proj}/... 파생)', () => {
    const resourceItems = allItems().filter((i) => i.kind === 'resource');
    expect(resourceItems).toHaveLength(8);
    for (const item of resourceItems) {
      expect(item.scope, `${item.id}.scope`).toBe('project');
    }
  });

  // 양성대조 — project 집합이 실제로 하나라도 빠지면(또는 늘면) 이 테스트가 잡는다는 것을
  // 스스로 증명(회귀가드가 아무 의미 없이 항상 그린이지 않다는 확認).
  it('양성대조 — 픽스처에서 project 항목 하나를 빼면 위 자가 실제로 어긋남을 잡는다', () => {
    const mutatedProjectIds = PROJECT_SCOPED_IDS.filter((id) => id !== 'activity');
    const realProjectIds = allItems().filter((i) => i.scope === 'project').map((i) => i.id).sort();
    expect(realProjectIds).not.toEqual([...mutatedProjectIds].sort());
  });
});
