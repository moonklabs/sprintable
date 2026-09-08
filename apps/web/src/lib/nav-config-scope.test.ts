import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './nav-config';

// story #9c5e82dc(IA·S3, PO 確定 2026-09-08) — 새 자: 「프로젝트 전환 시 내용이 바뀌는
// 항목」 대 「화면이 그렇다고 말하는 항목」 8:0→8:8(3600 문서 원안)이었으나, activity가
// kind:'static'인데도 project_id로 실제 필터되는 것을 코드로 확認해 9:9로 정정됐다
// (doc의 「실측」은 구현 前 추정 — 라이브 코드가 정본).
//
// 카디르 QA 재감사(2026-09-08, codex) — 고정 숫자 테스트(9/13/2)만으로는 "분류 자체가
// 틀렸다"를 못 잡는다는 게 실제로 드러났다: org-briefing·org-workforce가 원래 org로
// 분류됐었으나 화면 «일부» 패널만 project(나머지는 org)인 혼합 화면이었다. PO 원칙 —
// 표식은 "화면 전체에 대한 약속"이라 혼합/부수적 project_id 사용은 project로도 org로도
// 정직할 수 없어 애매(무표식)로 간다. 이 재감사로 애매가 2→4로 늘었다(9/11/4).
const PROJECT_SCOPED_IDS = ['board', 'goals', 'loops', 'standup', 'retro', 'docs', 'artifacts', 'storage', 'activity'];
// 애매(표식 없음) — scope 필드를 아예 안 쓴다.
// - inbox: 순수 개인 알림(project/org 필터 0)
// - settings: 계정 설정인데 팀원 탭 하나만 project라 섞인 화면
// - org-briefing: 「지금」(org 전체) + 「실험실」·「워크포스」(project_id로 실 데이터, 없으면
//   스켈레톤) 패널이 한 화면에 섞임(loop-face.tsx·workforce-face.tsx)
// - org-workforce: agents-page-tabs.tsx 4탭 중 stats·recruit는 project 걸리고
//   manage(기본)·access는 project 무관 — 탭에 따라 갈리는 혼합 화면
const AMBIGUOUS_IDS = ['inbox', 'settings', 'org-briefing', 'org-workforce'];

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

  it('org 스코프 11항목 — project·애매를 뺀 나머지 전부(카디르 QA 재감사로 13→11)', () => {
    const orgIds = allItems().filter((i) => i.scope === 'org').map((i) => i.id).sort();
    const expected = allItems()
      .map((i) => i.id)
      .filter((id) => !PROJECT_SCOPED_IDS.includes(id) && !AMBIGUOUS_IDS.includes(id))
      .sort();
    expect(orgIds).toEqual(expected);
    expect(orgIds).toHaveLength(11);
  });

  it('애매 4항목(inbox·settings·org-briefing·org-workforce)은 scope 필드 자체가 없다(undefined — org로 기본값 안 깖)', () => {
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

  // 혼합/부수적 project_id 사용은 project가 아니라 애매로 간다는 원칙의 회귀가드 —
  // org-trust는 project_id를 쓰지만(이름 보완용, 부수적) 실질 콘텐츠(trust-scores)는
  // org 전체라 org 유지다. 이 테스트가 org-briefing·org-workforce와 같은 취급으로
  // 잘못 끌려가면(애매로 오분류되면) 잡는다.
  it('org-trust는 project_id를 부수적으로만 쓰므로(이름 보완) 애매가 아니라 org다', () => {
    const item = allItems().find((i) => i.id === 'org-trust');
    expect(item?.scope).toBe('org');
  });

  // 양성대조 — project 집합이 실제로 하나라도 빠지면(또는 늘면) 이 테스트가 잡는다는 것을
  // 스스로 증명(회귀가드가 아무 의미 없이 항상 그린이지 않다는 확認).
  it('양성대조 — 픽스처에서 project 항목 하나를 빼면 위 자가 실제로 어긋남을 잡는다', () => {
    const mutatedProjectIds = PROJECT_SCOPED_IDS.filter((id) => id !== 'activity');
    const realProjectIds = allItems().filter((i) => i.scope === 'project').map((i) => i.id).sort();
    expect(realProjectIds).not.toEqual([...mutatedProjectIds].sort());
  });

  // 양성대조 — 애매 집합이 실제로 하나 빠지면(예 org-workforce가 다시 org로 잘못 돌아가면)
  // 이 테스트가 잡는다.
  it('양성대조 — 픽스처에서 애매 항목 하나를 빼면 위 자가 실제로 어긋남을 잡는다', () => {
    const mutatedAmbiguousIds = AMBIGUOUS_IDS.filter((id) => id !== 'org-workforce');
    const realAmbiguousIds = allItems().filter((i) => i.scope === undefined).map((i) => i.id).sort();
    expect(realAmbiguousIds).not.toEqual([...mutatedAmbiguousIds].sort());
  });
});
