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
import { VIDEO_PRODUCTION_RECIPE } from '@/lib/video-production-seed.test.fixture';
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
  payload_schema: { properties: { stage: { enum: ['draft', 'animatic', 'concept_confirmed'] } } },
  // story #4173 — 역할 2개(에이전트 크리에이터·사람 디렉터) 합성 정의. role_actor_kinds가
  // 없어도 «모든 stage가 게이트인 역할 = 승인 자리» 구조 신호로 판별된다.
  stage_metadata: {
    draft: { role: '크리에이터' },
    animatic: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
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
          recipe={RECIPE} open onOpenChange={() => {}}
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
          recipe={recipeWithUnknownApprover} open onOpenChange={() => {}}
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
          recipe={RECIPE} open onOpenChange={() => {}}
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

  // story #4173 — 자리는 정의가 가진 역할만큼만 그린다. 연산·발행 역할이 없는 정의엔 두 자리가
  // 아예 없다(예전엔 발행자 자리가 비활성으로 늘 떠 있었다).
  it('정의에 없는 연산·발행 자리는 그리지 않는다(역할 2개 정의 = 자리 2개)', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={() => {}}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    expect(document.body.querySelector('[data-testid="slot-compute"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="slot-publisher"]')).toBeNull();
    expect([...document.body.querySelectorAll('[data-role]')].map((el) => el.getAttribute('data-role'))).toEqual(['크리에이터', '디렉터']);
  });

  it('제출은 크리에이터 role_mapping만 담아 onSubmit을 부른다(디렉터·발행자 stage는 안 실림)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE} open onOpenChange={onOpenChange}
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
          recipe={RECIPE} open onOpenChange={() => {}}
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

  // story #4426 P1(카디르 실 시드 E2E 재현, 2026-09-19) — 한글 합성 role 값만으로는 실 seed의
  // 영어 role 키와의 어긋남을 못 잡는다([합성표본=구조숨김]). 아래는 실 seed 모양(영어 role
  // 키) 축소판. story #4173부터는 호출부가 role 키를 넘기지 않고 다이얼로그가 정의에서 자리를
  // 뽑으므로, 이 클래스의 어긋남 자체가 생길 자리가 없다(전체 seed 회귀는 아래 AC1 스위트).
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

  it('실 seed 모양(영어 role 키)으로 제출하면 roleMapping이 채워진다(#4426 핵심 회귀)', async () => {
    stubMemberFetch();
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={REAL_SEED_RECIPE} open onOpenChange={() => {}}
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

    // #4426 당시엔 role 키 불일치로 roleMapping이 항상 {}였다 — 실제로 채워지는지가 근본 pin.
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
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange}
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
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange}
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
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange}
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
          recipe={REAL_SEED_RECIPE} open onOpenChange={onOpenChange}
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
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}}
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
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}}
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
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}}
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
          recipe={RECIPE_WITH_PUBLISHER_TARGET} open onOpenChange={() => {}}
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

  // story #4114 — 연산 슬롯(publisherStages와 동형 SSOT, capability.target=
  // generation_connector). live_generation은 실 seed의 실제 stage 이름(#4101/#4110
  // 설명 그대로).
  const RECIPE_WITH_COMPUTE_TARGET: EventDefinitionResponse & { id: string } = {
    ...RECIPE,
    stage_metadata: {
      ...RECIPE.stage_metadata,
      live_generation: { role: '연산', capability: { kind: 'generate', target: 'generation_connector' } },
    },
  };

  function stubMemberAndGenerationFetch(connectors: { id: string; provider_key: string; label: string; status: string }[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url.startsWith('/api/organizations/org-1/generation-connectors')) {
        return { ok: true, json: async () => ({ data: { connectors } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  it('연산 — 있음: active 연산 커넥터가 select 옵션으로 렌더되고(revoked 등 비active는 제외)', async () => {
    stubMemberAndGenerationFetch([
      { id: 'gen-1', provider_key: 'vertex_gemini', label: '뭉클랩 기본 연산', status: 'active' },
      { id: 'gen-2', provider_key: 'vertex_gemini', label: '해지된 연산', status: 'revoked' },
    ]);
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_COMPUTE_TARGET} open onOpenChange={() => {}}
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();

    const computeSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="compute-connector-select"]')!;
    expect(computeSelect.disabled).toBe(false);
    const optionTexts = Array.from(computeSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('뭉클랩 기본 연산');
    expect(optionTexts).not.toContain('해지된 연산');
  });

  it('연산 — 없음: 0건이면 안내 문구가 뜨지만(발행자와 달리) 제출은 막히지 않는다(#4110 crew 폴백)', async () => {
    stubMemberAndGenerationFetch([]);
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 2 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_COMPUTE_TARGET} open onOpenChange={() => {}}
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

    const emptyHint = document.body.querySelector('[data-testid="marketing-apply-generation-connectors-empty"]')!;
    expect(emptyHint.textContent).toContain(koMessages.organization.eventApplyGenerationConnectorsEmpty);
    // story #4116(#4112 시안 §6) — 빈 상태 문장 끝 목적지 링크(apply-recipe-dialog.tsx(v1) 동형).
    const emptyLink = emptyHint.querySelector('a')!;
    expect(emptyLink).toBeTruthy();
    expect(emptyLink.getAttribute('href')).toBe('/organization/generation-connectors');
    const fallbackHint = document.body.querySelector('[data-testid="slot-compute"]')!.textContent;
    expect(fallbackHint).toContain(koMessages.organization.recipeApplyV2ComputeEmptyFallbackHint);
    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(false); // 발행자(publisherRequired)와 달리 필수 아님.

    await act(async () => { submitBtn.click(); });
    await flush();
    // 비워둔 채 제출 — live_generation stage 자체가 roleMapping에 없다(빈 문자열을 안 싣는다).
    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1', projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1' },
    });
  });

  it('연산 — 선택 제출: 고른 연산 커넥터 id가 role_mapping[live_generation]으로 실린다', async () => {
    stubMemberAndGenerationFetch([
      { id: 'gen-1', provider_key: 'vertex_gemini', label: '뭉클랩 기본 연산', status: 'active' },
    ]);
    const onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 3 }));
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_COMPUTE_TARGET} open onOpenChange={() => {}}
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
    const computeSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="compute-connector-select"]')!;
    await act(async () => { computeSelect.value = 'gen-1'; computeSelect.dispatchEvent(new Event('change', { bubbles: true })); });

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mkt-1', projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1', live_generation: 'gen-1' },
    });
  });

  it('연산 — 목록 fetch 실패: «없어요» 대신 로드 실패 문구+재시도, 재시도 성공하면 옵션이 채워진다', async () => {
    let shouldFail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }] };
      }
      if (url.startsWith('/api/organizations/org-1/generation-connectors')) {
        if (shouldFail) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: { connectors: [{ id: 'gen-1', provider_key: 'vertex_gemini', label: '뭉클랩 기본 연산', status: 'active' }] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={RECIPE_WITH_COMPUTE_TARGET} open onOpenChange={() => {}}
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="marketing-apply-generation-connectors-load-error"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="marketing-apply-generation-connectors-empty"]')).toBeNull();
    const computeSelect = document.body.querySelector<HTMLSelectElement>('[data-testid="compute-connector-select"]')!;
    expect(computeSelect.disabled).toBe(true);

    shouldFail = false;
    const retryBtn = [...document.body.querySelectorAll('[data-testid="marketing-apply-generation-connectors-load-error"] button')][0] as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await flush();

    expect(document.body.querySelector('[data-testid="marketing-apply-generation-connectors-load-error"]')).toBeNull();
    expect(computeSelect.disabled).toBe(false);
    const optionTexts = Array.from(computeSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('뭉클랩 기본 연산');
  });
});

// story #4107 — submitMarketingRecipeApply(BE 응답→FE onSubmit 계약 wrapper)가 실제로
// data.warnings를 읽어서 넘기는지 직접 핀(다이얼로그 레벨 테스트는 onSubmit을 목킹하므로
// 이 wrapper 자체의 파싱 축은 별도로 확인해야 한다 — #4107의 근본 버그가 정확히 이
// wrapper에 warnings 참조가 0이었다는 것).
// ── story #4173 — 정의로 구동하는 자리(AC1 영상 회귀 0 · AC2 역할 구성이 다른 정의) ──────────
const ORG = koMessages.organization;

function stubAll(opts: { members?: { id: string; name: string; type: string }[] } = {}) {
  const members = opts.members ?? [
    { id: 'agent-1', name: '댄', type: 'agent' },
    { id: 'agent-2', name: '리아', type: 'agent' },
    { id: 'human-1', name: '윤재', type: 'human' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members')) return { ok: true, json: async () => members };
    if (url.startsWith('/api/organizations/org-1/channel-connections')) {
      return { ok: true, json: async () => ({ data: [{ id: 'conn-1', channel: 'threads', account_label: '뭉클랩 스레드', account_id: 'a', status: 'active' }] }) };
    }
    if (url.startsWith('/api/organizations/org-1/generation-connectors')) {
      return { ok: true, json: async () => ({ data: { connectors: [{ id: 'gc-1', provider_key: 'fal', label: 'fal 세트', status: 'active' }] } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

type ApplyArgs = { recipeId: string; projectId: string; roleMapping: Record<string, string> };

async function mountDialog(recipe: EventDefinitionResponse & { id: string }, onSubmit = vi.fn(async (_args: ApplyArgs) => ({ ok: true, bindingsUpserted: 1 }))) {
  await act(async () => {
    root.render(wrap(
      <MarketingRecipeApplyDialog recipe={recipe} open onOpenChange={() => {}} projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={onSubmit} />,
    ));
  });
  await flush();
  return onSubmit;
}

async function choose(selector: string, value: string, index = 0) {
  const el = document.body.querySelectorAll<HTMLSelectElement>(selector)[index]!;
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

function submitButton() {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
}

describe('AC1 — 영상 레시피(실 seed) 적용 회귀 0(story #4173)', () => {
  it('자리 4개가 예전과 같은 순서·이름·배지로 그려진다(디렉터 · 크리에이터 · 연산 · 발행자)', async () => {
    stubAll();
    await mountDialog(VIDEO_PRODUCTION_RECIPE);
    const slots = [...document.body.querySelectorAll('[data-role]')].map((el) => ({
      testid: el.getAttribute('data-testid'), role: el.getAttribute('data-role'),
      header: el.querySelector('.font-semibold')?.textContent,
    }));
    expect(slots).toEqual([
      { testid: 'slot-director', role: 'Director', header: `디렉터 ${ORG.recipeApplyV2DirectorBadge}` },
      { testid: 'slot-creator', role: 'Creator', header: `크리에이터 ${ORG.recipeApplyV2CreatorBadge}` },
      { testid: 'slot-compute', role: 'Compute', header: `연산 ${ORG.recipeApplyV2ComputeBadge}` },
      { testid: 'slot-publisher', role: 'Publisher', header: `발행자 ${ORG.recipeApplyV2PublisherBadge}` },
    ]);
    expect(document.body.querySelector('[data-testid="director-approver"]')?.textContent).toBe(ORG.recipeGateApproverOrgOwner);
    // 설명 줄 = 그 역할이 맡은 단계 라벨(유나 확定) · 크리에이터는 4단계 실행.
    const creator = document.body.querySelector('[data-role="Creator"]')!;
    expect(creator.textContent).toContain([ORG.recipeStageLabelDraft, ORG.recipeStageLabelAnimatic, ORG.recipeStageLabelVerification, ORG.recipeStageLabelEditing].join(' · '));
    expect(creator.textContent).toContain(ORG.recipeApplyV2StageCoverage.replace('{count}', '4'));
  });

  it('발행 채널을 고르기 전엔 제출 불가(필수), 연산은 비워도 제출 가능 — 바인딩 결과가 예전과 같다', async () => {
    stubAll();
    const onSubmit = await mountDialog(VIDEO_PRODUCTION_RECIPE);
    await choose('#marketing-recipe-apply-project', 'proj-1');
    await choose('[data-testid="creator-agent-select"]', 'agent-1');
    expect(submitButton().hasAttribute('disabled')).toBe(true);
    await choose('[data-testid="publisher-connection-select"]', 'conn-1');
    expect(submitButton().hasAttribute('disabled')).toBe(false);
    await act(async () => { submitButton().click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: VIDEO_PRODUCTION_RECIPE.id, projectId: 'proj-1',
      roleMapping: { draft: 'agent-1', animatic: 'agent-1', verification: 'agent-1', editing: 'agent-1', published: 'conn-1' },
    });
  });

  it('연산 커넥터를 고르면 live_generation에 실린다', async () => {
    stubAll();
    const onSubmit = await mountDialog(VIDEO_PRODUCTION_RECIPE);
    await choose('#marketing-recipe-apply-project', 'proj-1');
    await choose('[data-testid="creator-agent-select"]', 'agent-1');
    await choose('[data-testid="publisher-connection-select"]', 'conn-1');
    await choose('[data-testid="compute-connector-select"]', 'gc-1');
    await act(async () => { submitButton().click(); });
    await flush();
    expect(onSubmit.mock.calls[0]![0].roleMapping).toEqual({
      draft: 'agent-1', animatic: 'agent-1', verification: 'agent-1', editing: 'agent-1', published: 'conn-1', live_generation: 'gc-1',
    });
  });
});

// 유나 design CHANGES(PR #4547) — 390에서 «크리에/이터»·«없/어요»처럼 낱말 중간이 잘리지 않게
// 자리 텍스트 칸 전체에 break-keep(카드와 같은 이유).
describe('자리 텍스트 줄바꿈(story #4173 유나 design)', () => {
  it('모든 자리의 텍스트 칸이 break-keep이다', async () => {
    stubAll();
    await mountDialog(VIDEO_PRODUCTION_RECIPE);
    const slots = [...document.body.querySelectorAll('[data-role]')];
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.firstElementChild?.className, slot.getAttribute('data-role') ?? '').toContain('break-keep');
    }
  });
});

describe('AC2 — 역할 구성이 다른 정의는 그 자리대로 그려지고 제출된다(story #4173)', () => {
  const BLOG: EventDefinitionResponse & { id: string } = {
    id: 'blog', key: 'preset.marketing.blog_post', org_id: null, name: '블로그 글', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'review', 'revise', 'published'] } } },
    stage_metadata: {
      draft: { role: 'Writer' },
      review: { role: 'Editor', gate: { type: 'external_publish', approver: 'org_owner' } },
      revise: { role: 'Writer' },
      published: { role: 'Publisher', capability: { kind: 'publish', target: 'channel_connection' } },
    },
    role_actor_kinds: { Writer: 'agent', Editor: 'human', Publisher: 'agent' },
    enabled: true,
  };

  const NEWSLETTER: EventDefinitionResponse & { id: string } = {
    id: 'news', key: 'preset.marketing.newsletter', org_id: null, name: '뉴스레터', description: null,
    payload_schema: { properties: { stage: { enum: ['research', 'draft', 'approve'] } } },
    stage_metadata: {
      research: { role: 'Researcher' },
      draft: { role: 'Writer' },
      approve: { role: 'Editor', gate: { type: 'external_publish', approver: 'org_owner' } },
    },
    role_actor_kinds: { Researcher: 'agent', Writer: 'agent', Editor: 'human' },
    enabled: true,
  };

  it('역할 3개(승인 · 에이전트 · 발행) — 사람 먼저 순서로 3자리, 제출 본문은 Writer 두 단계+발행 채널', async () => {
    stubAll();
    const onSubmit = await mountDialog(BLOG);
    expect([...document.body.querySelectorAll('[data-role]')].map((el) => [el.getAttribute('data-role'), el.getAttribute('data-testid')])).toEqual([
      ['Editor', 'slot-director'], ['Writer', 'slot-creator'], ['Publisher', 'slot-publisher'],
    ]);
    expect(document.body.querySelector('[data-testid="slot-compute"]')).toBeNull();
    await choose('#marketing-recipe-apply-project', 'proj-1');
    await choose('[data-testid="creator-agent-select"]', 'agent-1');
    await choose('[data-testid="publisher-connection-select"]', 'conn-1');
    await act(async () => { submitButton().click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ recipeId: 'blog', projectId: 'proj-1', roleMapping: { draft: 'agent-1', revise: 'agent-1', published: 'conn-1' } });
  });

  it('에이전트 역할 2개 — 자리 두 개가 각각 필수이고 역할마다 제 단계에 바인딩된다', async () => {
    stubAll();
    const onSubmit = await mountDialog(NEWSLETTER);
    expect(document.body.querySelectorAll('[data-testid="creator-agent-select"]')).toHaveLength(2);
    await choose('#marketing-recipe-apply-project', 'proj-1');
    await choose('[data-testid="creator-agent-select"]', 'agent-1', 0);
    expect(submitButton().hasAttribute('disabled')).toBe(true);
    await choose('[data-testid="creator-agent-select"]', 'agent-2', 1);
    expect(submitButton().hasAttribute('disabled')).toBe(false);
    await act(async () => { submitButton().click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ recipeId: 'news', projectId: 'proj-1', roleMapping: { research: 'agent-1', draft: 'agent-2' } });
  });

  it('게이트 없는 사람 역할은 사람 멤버를 고르는 자리다(에이전트는 안 뜬다)', async () => {
    stubAll();
    await mountDialog({ ...NEWSLETTER, role_actor_kinds: { Researcher: 'human', Writer: 'agent', Editor: 'human' } });
    await choose('#marketing-recipe-apply-project', 'proj-1');
    const researcher = document.body.querySelector('[data-role="Researcher"] select') as HTMLSelectElement;
    const names = [...researcher.options].map((o) => o.textContent);
    expect(names).toContain('윤재');
    expect(names).not.toContain('댄');
  });
});

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

// 까디르 QA(PR #4547) — 한 역할에 방식이 다른 단계가 섞인 정의(레시피 2호 이후 모양).
// 역할 이름은 묶음 머리에 한 번, 자리는 그 아래 줄로(유나 판정 §9) · 값은 그 자리 stage에만.
describe('MarketingRecipeApplyDialog — 한 역할에 자리 여럿(A·C)', () => {
  const MIXED: EventDefinitionResponse & { id: string } = {
    id: 'mixed-1', key: 'org.acme.newsletter_cycle', org_id: 'org-1', name: '뉴스레터', description: null,
    payload_schema: { properties: { stage: { enum: ['brief', 'draft', 'signoff', 'published'] } } },
    stage_metadata: {
      brief: { role: 'Lead' },
      draft: { role: 'Writer' },
      signoff: { role: 'Lead', gate: { type: 'doc_approval', approver: 'org_owner' } },
      published: { role: 'Writer', capability: { kind: 'publish', target: 'channel_connection' } },
    },
    role_actor_kinds: { Lead: 'human', Writer: 'agent' },
    enabled: true,
  };

  function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) {
        return { ok: true, json: async () => [{ id: 'agent-1', name: '댄', type: 'agent' }, { id: 'human-1', name: '윤재', type: 'human' }] };
      }
      if (url.startsWith('/api/organizations/org-1/channel-connections')) {
        return { ok: true, json: async () => ({ data: [{ id: 'conn-1', channel: 'stibee', account_label: '뉴스레터', account_id: 'a1', status: 'active' }] }) };
      }
      if (url.startsWith('/api/organizations/org-1/generation-connectors')) {
        return { ok: true, json: async () => ({ data: { connectors: [] } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  async function render(onSubmit = vi.fn(async () => ({ ok: true, bindingsUpserted: 3 }))) {
    stubFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={MIXED} open onOpenChange={() => {}}
          projects={[{ id: 'proj-1', name: 'Proj' }]} orgId="org-1" onSubmit={onSubmit}
        />,
      ));
    });
    await flush();
    return onSubmit;
  }

  const change = async (el: HTMLSelectElement, value: string) => {
    await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
  };

  it('자리가 둘인 역할은 role="group" 묶음 하나 — 역할 이름은 머리에 한 번, 줄은 방식별', async () => {
    await render();
    const groups = [...document.body.querySelectorAll<HTMLElement>('[data-testid="slot-group"]')];
    expect(groups.map((g) => g.dataset.role)).toEqual(['Lead', 'Writer']);
    for (const g of groups) {
      expect(g.getAttribute('role')).toBe('group');
      const heading = document.getElementById(g.getAttribute('aria-labelledby')!);
      expect(heading && g.contains(heading)).toBe(true);
    }
    const lines = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('[data-slot-key]')].map((l) => l.dataset.slotKey);
    expect(lines(groups[0]!)).toEqual(['Lead:member', 'Lead:approver']);
    expect(lines(groups[1]!)).toEqual(['Writer:member', 'Writer:channel']);
    // 역할 이름이 줄마다 반복되지 않는다(«왜 작성자가 둘?» 방지) — 묶음 안에 머리 한 번만.
    const writerLabel = groups[1]!.querySelector('[id]')!.textContent!;
    expect(groups[1]!.textContent!.split(writerLabel).length - 1).toBe(1);
  });

  it('A·C: 멤버·채널 값은 각자 자기 stage에만 실린다(채널 stage에 멤버 id가 안 들어감, 사람 작업 단계도 배정)', async () => {
    const onSubmit = await render();
    await change(document.body.querySelector<HTMLSelectElement>('#marketing-recipe-apply-project')!, 'proj-1');
    const memberSelects = [...document.body.querySelectorAll<HTMLSelectElement>('[data-testid="creator-agent-select"]')];
    expect(memberSelects).toHaveLength(2);
    await change(memberSelects[0]!, 'human-1'); // Lead 작업(brief) — 사람
    await change(memberSelects[1]!, 'agent-1'); // Writer 작업(draft) — 에이전트
    await change(document.body.querySelector<HTMLSelectElement>('[data-testid="publisher-connection-select"]')!, 'conn-1');

    const submitBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '적용하기')!;
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({
      recipeId: 'mixed-1', projectId: 'proj-1',
      roleMapping: { brief: 'human-1', draft: 'agent-1', published: 'conn-1' },
    });
    expect(document.body.querySelector('[data-testid="marketing-apply-uncovered-stages"]')).toBeNull();
  });

  it('묶음 안 선택기는 aria-label이 서로 다르다(역할 이름 · 방식 배지) — 자리 하나인 역할은 역할 이름 그대로', async () => {
    await render();
    const writer = document.body.querySelector<HTMLElement>('[data-testid="slot-group"][data-role="Writer"]')!;
    const labels = [...writer.querySelectorAll('select')].map((el) => el.getAttribute('aria-label'));
    const org = koMessages.organization;
    expect(labels).toEqual([`Writer · ${org.recipeApplyV2CreatorBadge}`, `Writer · ${org.recipeApplyV2PublisherBadge}`]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('영상 레시피(자리 하나씩)는 묶음 없이 지금 모양 그대로', async () => {
    stubMemberFetch();
    await act(async () => {
      root.render(wrap(
        <MarketingRecipeApplyDialog
          recipe={{ ...VIDEO_PRODUCTION_RECIPE, id: 'video' }} open onOpenChange={() => {}}
          projects={[{ id: 'proj-1', name: 'Proj' }]} onSubmit={async () => ({ ok: true })}
        />,
      ));
    });
    await flush();
    expect(document.body.querySelector('[data-testid="slot-group"]')).toBeNull();
    expect([...document.body.querySelectorAll<HTMLElement>('[data-slot-key]')].map((e) => e.dataset.slotKey))
      .toEqual(['Director:approver', 'Creator:member', 'Compute:compute', 'Publisher:channel']);
    // 자리 하나인 역할의 선택기 aria-label은 예전처럼 역할 이름만(배지 안 붙음).
    const creatorSelect = document.body.querySelector('[data-slot-key="Creator:member"] select')!;
    expect(creatorSelect.getAttribute('aria-label')).not.toContain(' · ');
  });
});

// PR #4547(유나 권고·PO 처방) — 발행 자리 배지는 다른 배지(사람·에이전트·모델)처럼 «고르는 대상의
// 이름». 예전 «담당»은 경고·설명문의 일반 낱말 «담당»과 겹쳤다(phrase-collision 가드가 잡은 진짜 겹침).
describe('발행 자리 배지 문구', () => {
  it('ko «채널» · en «Channel»', async () => {
    const en = (await import('../../../messages/en.json')).default;
    expect(koMessages.organization.recipeApplyV2PublisherBadge).toBe('채널');
    expect(en.organization.recipeApplyV2PublisherBadge).toBe('Channel');
  });
});
