import { describe, expect, it } from 'vitest';
import { LEGACY_NAV_ITEMS, NAV_GROUPS } from './nav-config';

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
// story #3845(UX-v3·FE 5·일감 2, 페드루 PO 確定 §④ 2026-09-14) — retro가 LEGACY_NAV_ITEMS
// 에서 빠지며(「일감」 탭으로 흡수, nav-config.ts 주석 참고) 9→8. standup은 「스프린트」
// 탭 임베딩(§①) 착지 前까지 아직 남아 있다(nav-config.ts 해당 주석 참고).
const PROJECT_SCOPED_IDS = ['board', 'goals', 'loops', 'standup', 'docs', 'artifacts', 'storage', 'activity'];
// 애매(표식 없음) — scope 필드를 아예 안 쓴다.
// - inbox: 순수 개인 알림(project/org 필터 0)
// - settings: 계정 설정인데 팀원 탭 하나만 project라 섞인 화면
// - org-briefing: 「지금」(org 전체) + 「실험실」·「워크포스」(project_id로 실 데이터, 없으면
//   스켈레톤) 패널이 한 화면에 섞임(loop-face.tsx·workforce-face.tsx)
// - org-workforce: agents-page-tabs.tsx 4탭 중 stats·recruit는 project 걸리고
//   manage(기본)·access는 project 무관 — 탭에 따라 갈리는 혼합 화면
const AMBIGUOUS_IDS = ['inbox', 'settings', 'org-briefing', 'org-workforce'];

// story #3824(UX-v3·FE 1, 2026-09-13) — 5항목 축소는 사이드바 "1급 노출" 재편일 뿐,
// scope 분류(project/org/애매) 자체는 화면의 실제 데이터 필터 성격을 서술하는 값이라
// 어느 진입점(NAV_GROUPS 1급이냐 LEGACY_NAV_ITEMS 커맨드 팔레트냐)에 있든 안 바뀐다 —
// 그래서 이 감사 축은 NAV_GROUPS만이 아니라 LEGACY_NAV_ITEMS까지 합쳐 23개 전부를 본다
// (item.scope는 app-sidebar.tsx의 ScopeMark 배지 렌더에만 쓰이지만, 분류 정확성 자체의
// 회귀가드로서 자리 이동과 무관하게 유효).
function allItems() {
  return [...NAV_GROUPS.flatMap((g) => g.items), ...LEGACY_NAV_ITEMS];
}

describe('NAV_GROUPS scope — story #9c5e82dc(IA·S3 AC1)', () => {
  // story #3743(UI 재설계 ③, 페드루 PO 決) — org-connectors 항목이 organization/channels로
  // 흡수·리다이렉트되며 nav에서 걷혔다(⑦ IA 25→24 실물, 이 파일 축으로는 24→23).
  // story #3845 §④ — retro가 「일감」 탭으로 흡수되며 23→22(standup은 §① 착지 뒤 21로).
  it('항목 22개 전부가 scope 분류 대상이다(회귀 시 이 수부터 어긋난다)', () => {
    expect(allItems()).toHaveLength(22);
  });

  it('project 스코프 8항목이 정확히 이 집합이다(story #3845로 9→8, retro 제외)', () => {
    const projectIds = allItems().filter((i) => i.scope === 'project').map((i) => i.id).sort();
    expect(projectIds).toEqual([...PROJECT_SCOPED_IDS].sort());
  });

  // story #3743 — org-connectors 걷힘으로 13→11→10(이 스토리에서 -1).
  it('org 스코프 10항목 — project·애매를 뺀 나머지 전부(카디르 QA 재감사로 13→11·#3743으로 11→10)', () => {
    const orgIds = allItems().filter((i) => i.scope === 'org').map((i) => i.id).sort();
    const expected = allItems()
      .map((i) => i.id)
      .filter((id) => !PROJECT_SCOPED_IDS.includes(id) && !AMBIGUOUS_IDS.includes(id))
      .sort();
    expect(orgIds).toEqual(expected);
    expect(orgIds).toHaveLength(10);
  });

  it('애매 4항목(inbox·settings·org-briefing·org-workforce)은 scope 필드 자체가 없다(undefined — org로 기본값 안 깖)', () => {
    for (const id of AMBIGUOUS_IDS) {
      const item = allItems().find((i) => i.id === id);
      expect(item?.scope, `${id}.scope`).toBeUndefined();
    }
  });

  it('kind:"resource" 항목(7개, story #3845로 8→7)은 전부 project 스코프다(라우트 자체가 /{ws}/{proj}/... 파생)', () => {
    const resourceItems = allItems().filter((i) => i.kind === 'resource');
    expect(resourceItems).toHaveLength(7);
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
