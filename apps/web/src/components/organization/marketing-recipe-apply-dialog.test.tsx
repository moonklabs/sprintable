// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 4슬롯 적용 다이얼로그 계약 핀 고정(PO 判定 2026-09-18,
// story #4046): 크리에이터만 실제 role_mapping으로 제출되고, 디렉터는 게이트 approver를
// 읽기 전용으로 보여주며, 연산 picker는 비활성(이 카드 범위 밖·#4101이 3번째 소비처로
// 배선 예정)이다. 발행자(채널 연결)는 story #4103(#4090 AC1 잔여, 페드루 PO 실측
// 2026-09-21)로 실 배선됐다 — capability.target=channel_connection 선언 stage가 있을
// 때만 active 채널 연결 select가 뜨고, 그 값이 role_mapping[published]로 제출된다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MarketingRecipeApplyDialog } from './marketing-recipe-apply-dialog';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { MARKETING_CREATOR_ROLE_KEY } from '@/lib/recipe-role-slots';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const RECIPE: EventDefinitionResponse & { id: string } = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: null,
  payload_schema: { properties: { stage: { enum: ['draft', 'animatic', 'concept_confirmed', 'published'] } } },
  stage_metadata: {
    draft: { role: '크리에이터' },
    animatic: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
    published: { role: '발행자' },
  },
  enabled: true,
};

function stubMemberFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members')) {
      return {
        ok: true,
        json: async () => [
          { id: 'agent-1', name: '댄', type: 'agent' },
          { id: 'human-1', name: '윤재', type: 'human' },
        ],
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

describe('MarketingRecipeApplyDialog — 4슬롯 다른 메커니즘', () => {
  it('디렉터는 게이트 approver를 읽기 전용으로 보여준다(role_mapping 아님)', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const approverEl = document.body.querySelector('[data-testid="director-approver"]');
    // ⛔story #4087 — raw approver 키('org_owner')를 그대로 노출하던 게 이 스토리가
    // 고치는 그 결함이다(내부어 0 캐논 위반). gate-approver-label.ts SSOT로 사람 낱말화.
    expect(approverEl?.textContent).toBe(koMessages.organization.recipeGateApproverOrgOwner);
    expect(approverEl?.textContent).not.toBe('org_owner');
  });

  it('미등재 approver 키는 raw 값 대신 중립 문구(«승인자 미지정»)로 렌더된다(story #4087 AC2)', async () => {
    stubMemberFetch();
    const recipeWithUnknownApprover: EventDefinitionResponse & { id: string } = {
      ...RECIPE,
      stage_metadata: {
        ...RECIPE.stage_metadata,
        concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'some_future_unmapped_key' } },
      },
    };
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={recipeWithUnknownApprover} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const approverEl = document.body.querySelector('[data-testid="director-approver"]');
    expect(approverEl?.textContent).toBe(koMessages.organization.recipeGateApproverUnknown);
    expect(approverEl?.textContent).not.toContain('some_future_unmapped_key');
  });

  it('크리에이터 select는 프로젝트 선택 뒤 agent 타입만(human 제외) 채워진다', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    const optionTexts = [...creatorSelect.options].map((o) => o.textContent);
    expect(optionTexts).toContain('댄');
    expect(optionTexts).not.toContain('윤재');
  });

  it('연산·발행자 select는 비활성(이 카드 범위 밖)', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    const computeSelect = document.body.querySelector('[data-testid="slot-compute"] select') as HTMLSelectElement;
    const publisherSelect = document.body.querySelector('[data-testid="slot-publisher"] select') as HTMLSelectElement;
    expect(computeSelect.disabled).toBe(true);
    expect(publisherSelect.disabled).toBe(true);
  });

  it('제출은 크리에이터 role_mapping만 담아 onSubmit을 부른다(디렉터·발행자 stage는 안 실림)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => {
      projectSelect.value = 'proj-1';
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => {
      creatorSelect.value = 'agent-1';
      creatorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1',
      projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1' },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('프로젝트 전환 시 이전 크리에이터 선택이 리셋되고, 이전 프로젝트 agent가 새 role_mapping에 안 실린다(페드루 QA #4424 qa:changes 재현)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('project_id=proj-1')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄(A)', type: 'agent' }] };
      }
      if (url.includes('project_id=proj-2')) {
        return { ok: true, json: async () => [{ id: 'agent-2', name: '리아(B)', type: 'agent' }] };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'A' }, { id: 'proj-2', name: 'B' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;

    // A 프로젝트에서 agent-1 선택.
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(creatorSelect.value).toBe('agent-1');

    // B로 전환 — 이전 선택이 리셋돼야 한다(수정 前엔 'agent-1'로 고착).
    await act(async () => { projectSelect.value = 'proj-2'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(creatorSelect.value).toBe('');

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(true); // 재선택 前엔 제출 불가.

    // B 소속 agent-2를 다시 골라야 제출 가능 — agent-1은 옵션에 없다(소속 아님).
    const optionValues = [...creatorSelect.options].map((o) => o.value);
    expect(optionValues).not.toContain('agent-1');
    await act(async () => { creatorSelect.value = 'agent-2'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1', projectId: 'proj-2', roleMapping: { draft: 'agent-2', animatic: 'agent-2' },
    });
  });

  // story #4426 P1(카디르 실 시드 E2E 재현, 2026-09-19) — 위 테스트들은 stage_metadata.role과
  // creatorRoleLabel 둘 다 이 파일이 만든 한글 값("크리에이터")이라 서로 항상 맞는다 —
  // 실제 앱 배선(events/page.tsx가 MARKETING_CREATOR_ROLE_KEY 상수를 넘김)이 seed의 실제
  // role 키와 어긋나도 이 파일만으론 못 잡는다([합성표본=구조숨김]). 아래는 실 상수+실
  // seed 모양(영어 role 키)으로 전체 제출 경로를 관통시켜 그 클래스를 pin한다.
  const REAL_SEED_RECIPE: EventDefinitionResponse & { id: string } = {
    id: 'mkt-real', key: 'preset.marketing.video_production', org_id: null,
    name: '영상 제작 (릴스·쇼츠)', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'animatic'] } } },
    // backend/alembic/versions/0381_preset_marketing_video_production_recipe.py
    // _STAGE_METADATA 그대로(축소판) — role 값이 실제로 영어 키다.
    stage_metadata: {
      draft: { role: 'Creator' },
      animatic: { role: 'Creator' },
      concept_confirmed: { role: 'Director', gate: { type: 'concept_approval', approver: 'org_owner' } },
    },
    enabled: true,
  };

  it('실 상수(MARKETING_CREATOR_ROLE_KEY)+실 seed 모양(영어 role 키)으로 제출하면 roleMapping이 채워진다(#4426 핵심 회귀)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={() => {}} creatorRoleLabel={MARKETING_CREATOR_ROLE_KEY}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    // 수정 前(구 상수='크리에이터')이었다면 roleMapping이 항상 {}였다 — 실제로 채워지는지가
    // 이 P1의 근본 pin이다.
    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-real', projectId: 'proj-1', roleMapping: { draft: 'agent-1', animatic: 'agent-1' },
    });
  });

  it('bindingsUpserted=0(서버가 실제로 0건 저장)이면 성공 화면 대신 no-op 에러를 낸다(거짓성공표시 방지)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 0 }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel={MARKETING_CREATOR_ROLE_KEY}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onOpenChange).not.toHaveBeenCalledWith(false); // 다이얼로그가 "성공"으로 안 닫힌다.
    expect(document.body.textContent).toContain('저장된 배정이 없어요');
  });

  // story #4107 — apply 응답의 warnings를 결과 영역에 표시한다(apply-recipe-dialog.tsx와
  // 동형). 경고가 있어도 적용은 이미 성공했으니 no-op 에러가 아니라 경고 목록을 보여주고,
  // 다이얼로그는 스스로 닫지 않는다(사용자가 봐야 하는 정보를 자동으로 치우지 않는다).
  it('apply 응답에 warnings가 있으면 경고 목록을 보여주고 다이얼로그를 닫지 않는다', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({
      ok: true, bindingsUpserted: 2, warnings: ["stage='published': connector_key='x' 커넥터가 아직 등록돼 있지 않아요"],
    }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel={MARKETING_CREATOR_ROLE_KEY}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onOpenChange).not.toHaveBeenCalledWith(false); // 경고가 있으면 자동으로 안 닫힌다.
    const warningsBox = document.body.querySelector('[data-testid="marketing-apply-warnings"]');
    expect(warningsBox).toBeTruthy();
    expect(warningsBox!.textContent).toContain("stage='published'");
    expect(document.body.textContent).not.toContain('저장된 배정이 없어요'); // no-op 에러 아님(적용은 성공).
    // 페드루 PO CHANGES(PR #4484 리뷰) — 이미 저장됐다는 사실을 먼저 명시(중립 "주의" 아님).
    expect(warningsBox!.textContent).toContain('적용됐어요');
    // «취소»(거짓 문장)·«적용하기»(재클릭 시 같은 upsert 반복)는 숨고, «확인» 단일 버튼만.
    expect([...document.body.querySelectorAll('button')].some((b) => b.textContent === '취소')).toBe(false);
    expect([...document.body.querySelectorAll('button')].some((b) => b.textContent === '적용하기')).toBe(false);
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="marketing-apply-warnings-confirm"]')!;
    expect(confirmBtn.textContent).toBe('확인');
    await act(async () => { confirmBtn.click(); });
    expect(onOpenChange).toHaveBeenCalledWith(false); // «확인» 클릭 = 그제서야 닫힘.
  });

  it('apply 응답에 warnings가 없으면(빈 배열) 경고 없이 그대로 성공 경로(다이얼로그 닫힘)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2, warnings: [] }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel={MARKETING_CREATOR_ROLE_KEY}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.body.querySelector('[data-testid="marketing-apply-warnings"]')).toBeNull();
  });

  it('ok:false(적용 실패)면 warnings 필드가 응답에 있어도 기존 오류 경로 그대로(경고 목록 안 뜸)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: false, error: '적용 실패 — 재시도해 주세요' }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange} creatorRoleLabel={MARKETING_CREATOR_ROLE_KEY}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(document.body.querySelector('[data-testid="marketing-apply-warnings"]')).toBeNull();
    expect(document.body.textContent).toContain('적용 실패 — 재시도해 주세요');
  });

  it('creatorRoleLabel이 seed의 실제 role 키와 안 맞으면(예: 재발) 제출 자체를 로컬에서 막는다(네트워크 왕복 0)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 5 }));
    await act(async () => {
      root.render(wrap(
        // 일부러 잘못된 라벨(표시 문구를 실수로 다시 넘기는 재발 시나리오).
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={onSubmit}
        />,
      ));
    });
    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    // creatorRoleLabel이 어긋나면 agentOptions 자체는 정상 조회되지만(팀원 API는 role_mapping과
    // 무관) role_mapping 계산이 빈 값이 된다 — 그래도 select는 채워지므로 값을 고른다.
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).not.toHaveBeenCalled(); // 로컬 방어선에서 막혀 API 자체를 안 부른다.
    expect(document.body.textContent).toContain('저장된 배정이 없어요');
  });

  // story #4103(#4090 AC1 잔여) — 발행자(채널 연결) 실 배선. capability.target=
  // channel_connection이 선언된 real-shape 레시피로만 재현(위 RECIPE는 무선언이라
  // publisherRequired 자체가 안 걸려 이 축을 검증 못 한다).
  const RECIPE_WITH_PUBLISHER_TARGET: EventDefinitionResponse & { id: string } = {
    ...RECIPE,
    stage_metadata: {
      ...RECIPE.stage_metadata,
      published: { role: '발행자', capability: { kind: 'publish', target: 'channel_connection' } },
    },
  };

  function stubMemberAndChannelFetch(channels: { id: string; channel: string; account_label: string | null; account_id: string; status: string }[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url.startsWith('/api/organizations/org-1/channel-connections')) {
        return { ok: true, json: async () => ({ data: channels }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  it('있음 — active 채널 연결이 발행자 select 옵션으로 렌더되고(revoked/disconnected 등 비active는 제외)', async () => {
    stubMemberAndChannelFetch([
      { id: 'conn-1', channel: 'instagram', account_label: '메인 인스타', account_id: 'a1', status: 'active' },
      { id: 'conn-2', channel: 'threads', account_label: null, account_id: 'a2', status: 'disconnected' },
    ]);
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();

    const publisherSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="publisher-connection-select"]')!;
    expect(publisherSelect.disabled).toBe(false);
    const optionTexts = Array.from(publisherSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('메인 인스타');
    expect(optionTexts).not.toContain('threads(a2)');
  });

  it('없음 — active 채널 연결 0건이면 안내 문구가 뜨고 제출 버튼이 비활성', async () => {
    stubMemberAndChannelFetch([]);
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const emptyHint = document.body.querySelector('[data-testid="marketing-apply-channels-empty"]');
    expect(emptyHint?.textContent).toBe(koMessages.organization.eventApplyChannelsEmpty);
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });

  it('선택 제출 — 발행자로 고른 채널 연결 id가 role_mapping[published]로 실려 onSubmit이 불린다', async () => {
    stubMemberAndChannelFetch([
      { id: 'conn-1', channel: 'instagram', account_label: '메인 인스타', account_id: 'a1', status: 'active' },
    ]);
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 3 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={onSubmit}
        />,
      ));
    });
    await flush();

    const projectSelect = document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!;
    await act(async () => { projectSelect.value = 'proj-1'; projectSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    const creatorSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="creator-agent-select"]')!;
    await act(async () => { creatorSelect.value = 'agent-1'; creatorSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    const publisherSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="publisher-connection-select"]')!;
    await act(async () => { publisherSelect.value = 'conn-1'; publisherSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1',
      projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1', published: 'conn-1' },
    });
  });

  // story #4103 CHANGES-1(페드루 PO 리뷰, 2026-09-21) — 채널 목록 fetch 실패를 "0건"과
  // 구분한다(#3521 agentsLoadFailed와 동형 축). 실패면 «없어요»(진짜 0건 문구) 대신
  // channelConnect.channelLoadFailed + 재시도 버튼 — 재시도 성공 시 옵션이 채워진다.
  it('채널 목록 fetch 실패 — «없어요» 대신 로드 실패 문구+재시도, 재시도 성공하면 옵션이 채워진다', async () => {
    let shouldFail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url.startsWith('/api/organizations/org-1/channel-connections')) {
        if (shouldFail) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: [{ id: 'conn-1', channel: 'instagram', account_label: '메인 인스타', account_id: 'a1', status: 'active' }] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}} creatorRoleLabel="크리에이터"
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="marketing-apply-channels-load-error"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="marketing-apply-channels-empty"]')).toBeNull();
    const publisherSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="publisher-connection-select"]')!;
    expect(publisherSelect.disabled).toBe(true);

    shouldFail = false;
    const retryBtn = [...document.body.querySelectorAll('[data-testid="marketing-apply-channels-load-error"] button')][0] as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await flush();

    expect(document.body.querySelector('[data-testid="marketing-apply-channels-load-error"]')).toBeNull();
    expect(publisherSelect.disabled).toBe(false);
    const optionTexts = Array.from(publisherSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('메인 인스타');
  });
});

// story #4107 — submitMarketingRecipeApply(BE 응답→FE onSubmit 계약 wrapper)가 실제로
// data.warnings를 읽어서 넘기는지 직접 핀(다이얼로그 레벨 테스트는 onSubmit을 목킹하므로
// 이 wrapper 자체의 파싱 축은 별도로 확인해야 한다 — #4107의 근본 버그가 정확히 이
// wrapper에 warnings 참조가 0이었다는 것).
describe('submitMarketingRecipeApply — BE 응답 warnings 파싱', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('성공 응답(ok:true)의 warnings 배열을 그대로 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, bindings_upserted: 2, warnings: ["stage='published': …"] }),
    })));
    const { submitMarketingRecipeApply } = await import('./marketing-recipe-apply-dialog');
    const result = await submitMarketingRecipeApply({ recipeId: 'r1', projectId: 'p1', roleMapping: { draft: 'a1' } });
    expect(result).toEqual({ ok: true, bindingsUpserted: 2, warnings: ["stage='published': …"] });
  });

  it('warnings가 없는 성공 응답은 warnings가 undefined로 남는다(신규 키 발명 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, bindings_upserted: 1 }),
    })));
    const { submitMarketingRecipeApply } = await import('./marketing-recipe-apply-dialog');
    const result = await submitMarketingRecipeApply({ recipeId: 'r1', projectId: 'p1', roleMapping: { draft: 'a1' } });
    expect(result.warnings).toBeUndefined();
  });
});
