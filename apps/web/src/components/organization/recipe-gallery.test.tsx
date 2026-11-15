// @vitest-environment jsdom
//
// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §1) AC1 계약 핀 고정: 마케팅
// 레시피와 개발 워크플로가 탭으로 분리되고, 각 카드가 단계/게이트/역할 수 배지를 보여주고,
// apply/detail 콜백이 그 레시피 객체로 불린다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CONNECTION_LABEL_KEY, RecipeList } from './recipe-gallery';
import { RECIPE_CONNECTION_TARGETS } from '@/lib/recipe-role-slots';
import { VIDEO_PRODUCTION_RECIPE } from '@/lib/video-production-seed.test.fixture';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

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

// #4039 seed shape(recipe-role-slots.test.ts와 동일 fixture 축소판) — 단계 3(디렉터1·
// 크리에이터1·발행자1)·게이트 1.
const MARKETING_RECIPE: EventDefinitionResponse = {
  id: 'mkt-1', key: 'preset.marketing.video_production', org_id: null,
  name: '영상 제작 (릴스·쇼츠)', description: '소재 확정부터 발행까지.',
  payload_schema: { properties: { stage: { enum: ['draft', 'concept_confirmed', 'published'] } } },
  stage_metadata: {
    draft: { role: '크리에이터' },
    concept_confirmed: { role: '디렉터', gate: { type: 'concept_approval', approver: 'org_owner' } },
    published: { role: '발행자' },
  },
  enabled: true,
};


async function renderList(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
}
function rowOf(id: string): HTMLElement {
  return container.querySelector(`[data-testid="recipe-card-${id}"]`) as HTMLElement;
}
async function openRowMenu(id: string) {
  const more = rowOf(id).querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement;
  await act(async () => { more.click(); });
}
function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}

// 4913 C2 — 3열 카드 격자 → 한 패널 안 행 목록(RowList). 보이는 것은 그대로, 상세(역할·연결)는 펼침 안으로.
describe('RecipeList — 행 목록(story #4048 AC1 계약 + 4913 C2)', () => {
  it('한 패널 안 RowList — 행마다 이름 · 설명 · 단계/게이트 수 칩이 줄에 뜬다', async () => {
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="마케팅 워크플로우" />);
    const list = container.querySelector('[data-testid="recipe-list"]')!;
    expect(list.getAttribute('data-slot')).toBe('ds-row-list');
    expect(list.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe('마케팅 워크플로우');
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    // story #4202 — 플랫폼 프리셋은 원문 name이 아니라 messages(recipePreset) 문안으로 그린다.
    const row = rowOf('mkt-1');
    expect(row.textContent).toContain(koMessages.recipePreset.videoProductionName);
    expect(row.textContent).toMatch(/단계\s*3/);
    expect(row.textContent).toMatch(/게이트\s*1/);
    // story #4173 — 역할 수 배지는 뺐다(역할 이름 행과 중복, 유나 앵커 §1).
    expect(row.textContent).not.toMatch(/역할\s*3/);
    // 옛 격자는 없다.
    expect(container.querySelector('[class*="grid-cols-3"], [class*="lg:grid-cols"]')).toBeNull();
  });

  it('«프로젝트에 적용» = 행 오른쪽 단추 → 그 레시피 객체로 onApply', async () => {
    const onApply = vi.fn();
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="x" onApply={onApply} />);
    const applyBtn = [...rowOf('mkt-1').querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용')!;
    await act(async () => { applyBtn.click(); });
    expect(onApply).toHaveBeenCalledWith(MARKETING_RECIPE);
  });

  it('«상세 보기» = «⋯» 메뉴 항목 → 그 레시피 객체로 onViewDetail (행 줄에는 «상세 보기» 글자 단추가 없다)', async () => {
    const onViewDetail = vi.fn();
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="x" onViewDetail={onViewDetail} />);
    expect([...rowOf('mkt-1').querySelectorAll('button')].some((b) => b.textContent === '상세 보기')).toBe(false);
    await openRowMenu('mkt-1');
    const items = menuItems();
    expect(items.map((i) => i.textContent)).toEqual(['상세 보기']);
    await act(async () => { items[0]!.click(); });
    expect(onViewDetail).toHaveBeenCalledWith(MARKETING_RECIPE);
  });

  it('우클릭 메뉴도 «⋯»와 같은 항목(상세 보기)', async () => {
    const onViewDetail = vi.fn();
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="x" onViewDetail={onViewDetail} />);
    const trigger = rowOf('mkt-1').querySelector('[data-slot="ds-row-context-trigger"]') as HTMLElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    expect(menuItems().map((i) => i.textContent)).toEqual(['상세 보기']);
  });

  it('핸들러를 안 주면 단추도 메뉴도 안 그린다(읽기 전용 호출부)', async () => {
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="x" />);
    expect([...rowOf('mkt-1').querySelectorAll('button')].some((b) => b.textContent === '프로젝트에 적용')).toBe(false);
    expect(rowOf('mkt-1').querySelector('[data-slot="ds-row-actions-trigger"]')).toBeNull();
  });

  it('행을 펼치면 역할 · 연결이 뜨고, 한 번에 하나만 열린다', async () => {
    const other = { ...MARKETING_RECIPE, id: 'mkt-2', key: 'preset.marketing.other', name: '다른 레시피' };
    await renderList(<RecipeList recipes={[MARKETING_RECIPE, other]} loading={false} error={null} emptyMessage="-" ariaLabel="x" />);
    expect(container.querySelector('[data-testid="recipe-card-roles"]')).toBeNull();
    const chevron = (id: string) => rowOf(id).querySelector('button[aria-expanded]') as HTMLElement;
    expect(chevron('mkt-1').getAttribute('aria-expanded')).toBe('false');
    await act(async () => { chevron('mkt-1').click(); });
    expect(chevron('mkt-1').getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('mkt-1').querySelector('[data-testid="recipe-card-roles"]')).not.toBeNull();
    await act(async () => { chevron('mkt-2').click(); });
    expect(chevron('mkt-1').getAttribute('aria-expanded')).toBe('false');
    expect(rowOf('mkt-1').querySelector('[data-testid="recipe-card-roles"]')).toBeNull();
    expect(rowOf('mkt-2').querySelector('[data-testid="recipe-card-roles"]')).not.toBeNull();
  });

  it('더블클릭 · Enter = 행 펼침(Enter 한 번 더 = 접힘 · Esc = 접힘) — 행 안 단추를 더블클릭한 것은 펼침이 아니다', async () => {
    await renderList(<RecipeList recipes={[MARKETING_RECIPE]} loading={false} error={null} emptyMessage="-" ariaLabel="x" onApply={() => {}} />);
    const main = rowOf('mkt-1').querySelector('[data-row-main]') as HTMLElement;
    const roles = () => rowOf('mkt-1').querySelector('[data-testid="recipe-card-roles"]');
    const apply = [...rowOf('mkt-1').querySelectorAll('button')].find((b) => b.textContent === '프로젝트에 적용')!;
    await act(async () => { apply.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(roles()).toBeNull();
    await act(async () => { main.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(roles()).not.toBeNull();
    const key = (k: string) => act(async () => { main.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
    await key('Escape');
    expect(roles()).toBeNull();
    await key('Enter');
    expect(roles()).not.toBeNull();
    await key('Enter');
    expect(roles()).toBeNull();
  });

  it('로딩 · 에러 · 빈 상태 문구가 각각 뜬다(회귀 0 — 셋 다 다른 조건)', async () => {
    await renderList(<RecipeList recipes={[]} loading error={null} emptyMessage="표시할 워크플로우가 없어요" ariaLabel="x" />);
    expect(container.textContent).toContain('불러오는 중');
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recipe-list"]')).toBeNull();

    await renderList(<RecipeList recipes={[]} loading={false} error="boom" emptyMessage="표시할 워크플로우가 없어요" ariaLabel="x" />);
    expect(container.textContent).toContain('워크플로우를 불러오지 못했어요');
    expect(container.textContent).not.toContain('표시할 워크플로우가 없어요');

    await renderList(<RecipeList recipes={[]} loading={false} error={null} emptyMessage="표시할 워크플로우가 없어요" ariaLabel="x" />);
    expect(container.textContent).toContain('표시할 워크플로우가 없어요');
    expect(container.querySelector('[data-testid="recipe-list"]')).toBeNull();
  });
});

// story #4173(유나 디자인 앵커 2026-09-23) — 카드가 필요한 역할 이름·필요한 연결을 보여준다.
// 역할 순서는 적용 다이얼로그 자리와 같은 함수(사람 먼저 → 흐름 순서).
describe('RecipeList — 역할·연결 행(story #4173, 펼침 안)', () => {
  async function renderCards(recipes: EventDefinitionResponse[]) {
    await act(async () => {
      root.render(wrap(<RecipeList recipes={recipes} loading={false} error={null} emptyMessage="-" ariaLabel="x" />));
    });
    // 역할 · 연결은 행 펼침 안 — 모든 행을 차례로 펼쳐 읽는다(한 번에 하나만 열려서 id마다 따로).
    const read = new Map<string, { roles?: string | null; connections?: string | null }>();
    for (const r of recipes) {
      const chevron = rowOf(r.id).querySelector('button[aria-expanded]') as HTMLElement;
      await act(async () => { chevron.click(); });
      read.set(r.id, {
        roles: rowOf(r.id).querySelector('[data-testid="recipe-card-roles"]')?.textContent,
        connections: rowOf(r.id).querySelector('[data-testid="recipe-card-connections"]')?.textContent,
      });
    }
    return (id: string) => read.get(id)!;
  }
  const BLOG: EventDefinitionResponse = {
    id: 'blog', key: 'preset.marketing.blog_post', org_id: null, name: '블로그 글', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'review', 'published'] } } },
    stage_metadata: {
      draft: { role: 'Writer' },
      review: { role: 'Editor', gate: { type: 'external_publish', approver: 'org_owner' } },
      published: { role: 'Publisher', capability: { kind: 'publish', target: 'channel_connection' } },
    },
    role_actor_kinds: { Writer: 'agent', Editor: 'human', Publisher: 'agent' },
    enabled: true,
  };
  const NO_CONNECTION: EventDefinitionResponse = {
    id: 'plain', key: 'preset.marketing.comment_reply', org_id: null, name: '댓글 응대', description: null,
    payload_schema: { properties: { stage: { enum: ['draft', 'approve'] } } },
    stage_metadata: { draft: { role: 'Agent' }, approve: { role: 'Human', gate: { type: 'external_publish', approver: 'org_owner' } } },
    enabled: true,
  };
  const NO_ROLES: EventDefinitionResponse = {
    id: 'signal', key: 'preset.goal.measured', org_id: null, name: '목표 측정', description: null,
    payload_schema: {}, stage_metadata: {}, enabled: true,
  };

  it('영상 레시피(실 seed) — 디렉터(사람) · 크리에이터 · 연산 · 발행자 / 발행 채널 · 생성 연결(선택)', async () => {
    const card = await renderCards([VIDEO_PRODUCTION_RECIPE]);
    expect(card(VIDEO_PRODUCTION_RECIPE.id)).toEqual({
      roles: '디렉터(사람) · 크리에이터 · 생성 · 발행자',
      connections: '발행 채널 · 생성 연결(선택)',
    });
  });

  it('역할 3개·채널만 필요한 정의 — 사람 역할이 흐름과 무관하게 먼저, 연결은 발행 채널만', async () => {
    const card = await renderCards([BLOG]);
    expect(card('blog').roles).toBe('Editor(사람) · Writer · 발행자');
    expect(card('blog').connections).toBe('발행 채널');
  });

  it('연결이 없는 정의는 행을 숨기지 않고 «없음», role_actor_kinds가 없으면 «(사람)»을 붙이지 않는다', async () => {
    const card = await renderCards([NO_CONNECTION]);
    expect(card('plain')).toEqual({ roles: '에이전트 · 사람', connections: '없음' });
  });

  it('either 역할에도 접미사 «(사람 또는 에이전트)» — 안 붙이면 «에이전트 전용»으로 읽힌다(story #4243 · 유나 확정)', async () => {
    const card = await renderCards([{ ...BLOG, id: 'either', role_actor_kinds: { Writer: 'either', Editor: 'human', Publisher: 'agent' } }]);
    expect(card('either').roles).toBe('Editor(사람) · Writer(사람 또는 에이전트) · 발행자');
  });

  it('역할이 하나도 없으면 역할 행도 «없음»', async () => {
    const card = await renderCards([NO_ROLES]);
    expect(card('signal')).toEqual({ roles: '없음', connections: '없음' });
  });
});

// 페드루 PO(PR #4547) — 라벨 표를 가드 친화 모양(Record<string, string>)으로 두면서 tsc가 더는
// «target이 늘었는데 라벨 키를 빼먹는» 경우를 못 잡는다 — 여기서 빠짐을 대신 잡는다.
describe('연결 라벨 표 완전성(story #4173)', () => {
  it('RECIPE_CONNECTION_TARGETS 전부가 라벨 표에 있고, 그 키가 ko·en 문구로 실재한다', () => {
    for (const { target } of RECIPE_CONNECTION_TARGETS) {
      const key = CONNECTION_LABEL_KEY[target];
      expect(key, target).toBeDefined();
      expect((koMessages.organization as Record<string, string>)[key!], `ko ${key}`).toBeTruthy();
      expect((enMessages.organization as Record<string, string>)[key!], `en ${key}`).toBeTruthy();
    }
  });
});

// story #4202 — 플랫폼 프리셋 이름·설명은 로케일 문안(messages recipePreset), 조직 커스텀 정의는 원문.
describe('RecipeList — 플랫폼 프리셋 이름·설명 로케일(story #4202)', () => {
  async function renderGrid(recipe: EventDefinitionResponse, locale: 'ko' | 'en') {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
          <RecipeList recipes={[recipe]} loading={false} error={null} emptyMessage="" ariaLabel="x" />
        </NextIntlClientProvider>,
      );
    });
    return container.textContent ?? '';
  }

  it('en — 플랫폼 프리셋은 영어 이름·설명(원문 한국어 0)', async () => {
    const text = await renderGrid(MARKETING_RECIPE, 'en');
    expect(text).toContain(enMessages.recipePreset.videoProductionName);
    expect(text).toContain(enMessages.recipePreset.videoProductionDescription);
    expect(text).not.toContain(MARKETING_RECIPE.name);
    expect(text).not.toContain(MARKETING_RECIPE.description!);
  });

  it('ko — 플랫폼 프리셋은 ko 문안(= 시드 원문)', async () => {
    const text = await renderGrid(MARKETING_RECIPE, 'ko');
    expect(text).toContain(koMessages.recipePreset.videoProductionName);
    expect(text).toContain(koMessages.recipePreset.videoProductionDescription);
  });

  it('조직 커스텀 정의는 같은 key여도 원문 그대로(en에서도)', async () => {
    const custom = { ...MARKETING_RECIPE, id: 'org-1', org_id: 'org-uuid', name: '우리 팀 영상', description: '우리 팀 설명' };
    const text = await renderGrid(custom, 'en');
    expect(text).toContain('우리 팀 영상');
    expect(text).toContain('우리 팀 설명');
    expect(text).not.toContain(enMessages.recipePreset.videoProductionName);
  });

  it('표에 없는 플랫폼 key는 원문 그대로', async () => {
    const unknown = { ...MARKETING_RECIPE, id: 'x', key: 'preset.marketing.not_yet_keyed', name: '새 프리셋', description: '새 설명' };
    const text = await renderGrid(unknown, 'en');
    expect(text).toContain('새 프리셋');
    expect(text).toContain('새 설명');
  });
});
