// @vitest-environment jsdom
//
// story 4911 (루프 상세 재건축) — 구조 단언. 되돌리면(옛 한 줄 본문 · 옛 머리 줄 · 옛 팔레트) 빨개지는 것만 둔다.
// 하위 부품(후보 갤러리 · 과거 학습 · 미리보기 · AI 표시)은 «진짜»를 그린다(스텁하지 않는다 — 옛 팔레트 0은 그린 DOM으로 센다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { LoopDetailClient } from './loop-detail-client';
import { VARIANT_REASON_FACE } from '@/components/loops/variant-gallery';
import koMessages from '../../../../../../../messages/ko.json';

const { replaceMock, fetchWithAuthMock } = vi.hoisted(() => ({ replaceMock: vi.fn(), fetchWithAuthMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: replaceMock }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: 'org-1' }) }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/me-client', () => ({ fetchMe: () => fetchWithAuthMock('/api/me') }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = 'draft' | 'briefing' | 'generating' | 'deciding' | 'executing' | 'measuring' | 'closed' | 'abandoned';
const loopOf = (extra: Record<string, unknown> = {}) => ({
  id: 'loop-1', project_id: 'p1', parent_loop_id: null, hypothesis_id: null, brief_doc_id: null, recipe_slug: null,
  title: '주간 가입 전환 개선', goal_tags: [], status: 'draft' as Status, outcome_snapshot: null, ...extra,
});
const art = (id: string, decision: 'pending' | 'chosen' | 'rejected', extra: Record<string, unknown> = {}) => ({
  id, loop_id: 'loop-1', asset_id: `s-${id}`, variant_group: 'headline', variant_label: `후보 ${id}`, decision,
  choose_reason: null, rejection_reason: null, sort_order: 0, content_type: 'text/plain', text_content: `카피 ${id}`, text_truncated: false, ...extra,
});
const PACK = {
  items: [{ entity_type: 'loop', entity_id: 'l-9', similarity: 0.82, goal: '예전 가입 실험', decision: { chosen: { label: 'A', reason: '숫자가 좋아서' }, rejected: [{ label: 'B', reason: '길어서' }] }, outcome: { hypothesis_status: 'verified', metric: 'signup', actual: 12, target: 10, direction: 'up' }, href: '/ws1/proj1/loops/l-9' }],
  embed_available: true, synthesis: '배운 것 요약', synthesis_confidence: 'high', recommendation: '이번엔 짧게', recommendation_confidence: 'medium', evidence_count: 3,
};

let container: HTMLDivElement;
let root: Root;
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
    <TopBarProvider><TopBarTitleProbe />{node}</TopBarProvider>
  </NextIntlClientProvider>
);
function TopBarTitleProbe() { const { title } = useTopBar(); return <div data-testid="topbar">{title}</div>; }

type Scenario = { packPending?: boolean; loop?: Record<string, unknown>; groups?: unknown[]; human?: boolean; pack?: unknown; hypothesis?: string | null; brief?: { id: string; title: string; slug: string } | null };
function serve(sc: Scenario = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { type: sc.human === false ? 'agent' : 'human' } }) };
    if (url.includes('/artifacts')) return { ok: true, json: async () => sc.groups ?? [] };
    if (url.includes('/context-pack') && sc.packPending) return new Promise(() => {});
    if (url.includes('/context-pack')) return new Response(JSON.stringify(sc.pack ?? { items: [], embed_available: true }), { status: 200 });
    if (url.includes('/api/hypotheses/')) return { ok: true, json: async () => ({ data: { id: 'h1', statement: sc.hypothesis ?? '' } }) };
    if (url.includes('/api/docs/')) return { ok: true, json: async () => ({ data: sc.brief }) };
    if (url.includes('/api/loops/loop-1')) return { ok: true, json: async () => loopOf(sc.loop) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}
async function mount(sc: Scenario = {}) {
  serve(sc);
  await act(async () => { root.render(wrap(<LoopDetailClient loopId="loop-1" wsSlug="ws1" projSlug="proj1" projectId="p1" />)); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockReset(); replaceMock.mockClear(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => Array.from(container.querySelectorAll<HTMLElement>(sel));
const railLabels = () => qa('[data-slot="ds-summary-item"] dt').map((e) => e.textContent);

describe('[SID:4911] 루프 상세 — 틀 · 속성 칸', () => {
  it('제목은 본문 머리 h1 하나이고, 본문 + 옆 속성 칸(16rem)의 두 칸 틀이다(옛 한 줄 본문 아님)', async () => {
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(q('h1')!.textContent).toBe('주간 가입 전환 개선');
    expect(q('[data-slot="ds-page-frame"]')!.getAttribute('data-width')).toBe('wide');
    const split = q('[data-slot="ds-page-split"]')!;
    expect(q('[data-slot="ds-page-split-main"]')).not.toBeNull();
    expect(split.querySelector('aside')!.getAttribute('aria-label')).toBe('실행 정보');
    expect(split.querySelector('[data-slot="ds-summary-card"]')).not.toBeNull();
    // h1은 두 칸 위(틀 머리)에 있다 — 옆 칸이 제목 줄에서 시작하지 않는다
    expect(split.contains(q('h1'))).toBe(false);
  });

  it('속성 칸 = 단계 · 결정 진행 · 레시피 · 계보 · 브리프 · 성과 · 태그 — 값이 있는 것만, 이 순서로', async () => {
    await mount({
      loop: { status: 'closed', parent_loop_id: '1234567890abcdef', recipe_slug: 'weekly-signup', goal_tags: ['retention', 'growth'], hypothesis_id: 'h1', brief_doc_id: 'd1',
        outcome_snapshot: { hypothesis_id: 'h1', hypothesis_status: 'verified', outcome_result: { metric: 'signup', target: 10, actual: 12, direction: 'up', scored_at: '' }, attributed_at: '' } },
      groups: [{ variant_group: 'headline', artifacts: [art('a1', 'chosen', { choose_reason: '숫자' }), art('a2', 'rejected', { rejection_reason: '길어' })] }],
      hypothesis: '가입 비율을 올린다', brief: { id: 'd1', title: '주간 브리프', slug: 'weekly' },
    });
    expect(railLabels()).toEqual(['단계', '결정 진행', '레시피', '계보', '브리프 문서', '성과', '태그']);
    const text = q('[data-slot="ds-summary-card"]')!.textContent!;
    expect(text).toContain('1/1 슬롯');
    expect(text).toContain('weekly-signup');
    expect(text).toContain('#12345678에서 파생');
    expect(text).toContain('retention');
    expect(q('[data-slot="ds-summary-card"] a')!.getAttribute('href')).toBe('/docs/weekly');
    expect(q('[data-slot="ds-summary-card"] [data-outcome="hit"]')!.textContent).toContain('적중');
    expect(text).toContain('signup: 실제 12');
  });

  it('값이 없으면 그 항목은 없다: 초안 + 아무것도 없는 실행의 속성 칸은 «단계» 하나', async () => {
    await mount();
    expect(railLabels()).toEqual(['단계']);
    const stage = q('[data-slot="ds-summary-item"]')!;
    expect(stage.querySelector('[data-slot="loop-stage-bar"]')).not.toBeNull();
    expect(stage.querySelector('[data-loop-status="draft"]')!.textContent).toBe('초안');
  });

  it('머리에 상태 배지 · 계보 · 레시피 · 태그 줄이 다시 서지 않는다(같은 말 반복 0): 본문 쪽에는 상태 칩이 없다', async () => {
    await mount({ loop: { status: 'executing', recipe_slug: 'r1', goal_tags: ['t1'] } });
    const main = q('[data-testid="loop-detail-main"]')!;
    expect(main.querySelector('[data-loop-status]')).toBeNull();
    expect(main.textContent).not.toContain('r1');
    expect(main.textContent).not.toContain('t1');
    expect(qa('[data-loop-status]')).toHaveLength(1);
  });

  it('«목록으로»는 상단 막대의 ds Button이고 누르면 목록으로 replace 한다', async () => {
    await mount();
    const back = q('[data-testid="topbar"] button')!;
    expect(back.getAttribute('data-slot')).toBe('ds-button');
    expect(back.textContent).toContain('목록으로');
    await act(async () => { back.click(); });
    expect(replaceMock).toHaveBeenCalledWith('/ws1/proj1/loops');
  });
});

describe('[SID:4911] 루프 상세 — 본문(띠 · 목표 · 후보 · 과거 학습)', () => {
  it('결정 중 + 슬롯 있음: «이유가 다음 실행을 학습한다» 안내 띠(문구 그대로) · 사람이면 «사람 전용» 띠는 없다', async () => {
    await mount({ loop: { status: 'deciding' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'pending'), art('a2', 'pending')] }] });
    const banners = qa('[data-slot="ds-banner"]').map((b) => b.textContent);
    expect(banners.some((b) => b!.includes('결정 이유는 다음 실행이 학습해요') && b!.includes('왜 골랐고 왜 아닌지가 복리 조직기억의 신호예요.'))).toBe(true);
    expect(banners.some((b) => b!.includes('실행 결정은 사람 멤버만 할 수 있어요'))).toBe(false);
  });

  it('에이전트가 결정 중 실행을 보면 «사람 전용» 띠가 선다(문구 그대로)', async () => {
    await mount({ loop: { status: 'deciding' }, human: false, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'pending')] }] });
    expect(qa('[data-slot="ds-banner"]').some((b) => b.textContent!.includes('실행 결정은 사람 멤버만 할 수 있어요(에이전트 불가).'))).toBe(true);
  });

  it('결정 단계가 아닌데 후보가 있으면 «후보만 볼 수 있어요» 한 줄', async () => {
    await mount({ loop: { status: 'executing' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'chosen')] }] });
    expect(container.textContent).toContain('이 실행은 결정 단계가 아니에요 — 후보만 볼 수 있어요.');
    expect(qa('[data-slot="ds-banner"]')).toHaveLength(0);
  });

  it('목표 칸: 가설 문장 · 없으면 «연결된 가설이 없어요.»', async () => {
    await mount({ loop: { hypothesis_id: 'h1' }, hypothesis: '가입한 사람이 첫 주에 한 번 더 돌아오는 비율을 올린다' });
    expect(q('[data-testid="loop-goal"]')!.textContent).toContain('목표 · 가설');
    expect(q('[data-testid="loop-goal"]')!.textContent).toContain('가입한 사람이 첫 주에 한 번 더 돌아오는 비율을 올린다');
  });

  it('목표 칸: 가설이 없으면 안내 글', async () => {
    await mount();
    expect(q('[data-testid="loop-goal"]')!.textContent).toContain('연결된 가설이 없어요.');
  });

  it('후보가 없으면 큰 빈 칸 대신 한 줄(머리 · 갤러리 없음), 있으면 «후보 산출물 N» 머리 + 슬롯 카드', async () => {
    await mount();
    expect(q('[data-slot="variant-empty"]')!.textContent).toContain('아직 후보 산출물이 없어요');
    expect(q('[data-slot="variant-slot"]')).toBeNull();
    expect(qa('h2').some((h) => h.textContent!.startsWith('후보 산출물'))).toBe(false);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ loop: { status: 'deciding' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'pending'), art('a2', 'pending')] }] });
    const heading = qa('h2').find((h) => h.textContent!.startsWith('후보 산출물'))!;
    expect(heading.querySelector('[data-slot="ds-count-badge"]')!.textContent).toBe('1');
    expect(qa('[data-slot="variant-slot"]')).toHaveLength(1);
    expect(q('[data-slot="variant-empty"]')).toBeNull();
  });

  it('⭐비었거나 못 가져온 «과거 학습»은 한 줄로 접혀 있고(큰 빈 칸 0), 있으면 펼쳐 있다 · 눌러서 접고 펼 수 있다', async () => {
    await mount();
    const pack = q('[data-slot="context-pack"]')!;
    expect(pack.getAttribute('data-collapsed')).toBe('true');
    expect(pack.textContent).toContain('관련된 과거 실행이 없어요');
    expect(pack.textContent).not.toContain(koMessages.loops.contextPackSubtitle);
    const toggle = pack.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(pack.getAttribute('data-collapsed')).toBe('false');
    expect(pack.textContent).toContain(koMessages.loops.contextPackSubtitle);
  });

  it('불러오는 동안에는 접을 수 없다(스켈레톤 · 느림 안내가 사라지지 않게) — 눌러도 열려 있다', async () => {
    await mount({ packPending: true });
    const pack = q('[data-slot="context-pack"]')!;
    expect(pack.getAttribute('data-collapsed')).toBe('false');
    expect(pack.querySelector('[data-slot="ds-skeleton"]')).not.toBeNull();
    await act(async () => { (pack.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
    expect(pack.getAttribute('data-collapsed')).toBe('false');
    expect(pack.querySelector('[data-slot="ds-skeleton"]')).not.toBeNull();
  });

  it('요약 글(건수 · 비었음 · 못 가져옴)은 줄어들지 않는 머리 오른쪽 칸이 아니라 머리 «아래» 한 줄에 선다(좁은 폭에서 제목을 밀지 않게)', async () => {
    await mount();
    const pack = q('[data-slot="context-pack"]')!;
    const header = pack.querySelector('[data-slot="ds-section-header"]')!;
    expect(header.textContent).not.toContain('관련된 과거 실행이 없어요');
    expect(pack.querySelector('[data-testid="context-pack-summary"]')!.textContent).toBe('관련된 과거 실행이 없어요');
  });

  it('과거 학습이 있으면 펼쳐 있고 건수 · 학습 요약 · 제안 · 근거 카드가 선다', async () => {
    await mount({ pack: PACK });
    const pack = q('[data-slot="context-pack"]')!;
    expect(pack.getAttribute('data-collapsed')).toBe('false');
    expect(pack.textContent).toContain('유사 항목 1건');
    expect(pack.textContent).toContain('배운 것 요약');
    expect(pack.textContent).toContain('이번엔 짧게');
    expect(pack.textContent).toContain('예전 가입 실험');
    expect(pack.querySelector('[data-slot="ai-attribution"]')!.getAttribute('data-tone')).toBe('info'); // AI 표시 = info
    expect(pack.querySelector('a')!.getAttribute('href')).toBe('/ws1/proj1/loops/l-9');
  });
});

describe('[SID:4911] 루프 상세 — 결정 슬롯(ds Radio · ds Textarea)', () => {
  const deciding = { loop: { status: 'deciding' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'pending'), art('a2', 'pending')] }] };

  it('고르는 중인 슬롯 = 이름 있는 라디오 묶음(슬롯 이름) · 후보마다 ds Radio · 이유 칸은 ds Textarea(이름 있음)', async () => {
    await mount(deciding);
    const group = q('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('headline');
    expect(group.querySelectorAll('[data-slot="ds-radio"]')).toHaveLength(2);
    // 폼 직렬화용 이름 = 슬롯 이름(옛 input name="slot-…"과 같은 구실) · 후보마다 이름이 달라 스크린리더가 A와 B를 가른다
    expect(Array.from(group.querySelectorAll('input[type="radio"]')).every((i) => i.getAttribute('name') === 'headline')).toBe(true);
    const radioNames = Array.from(group.querySelectorAll('[data-slot="ds-radio"]')).map((r) => document.getElementById(r.getAttribute('aria-labelledby')!)!.textContent);
    expect(radioNames).toEqual(['선택 · 후보 a1', '선택 · 후보 a2']);
    const areaNames = Array.from(group.querySelectorAll('textarea')).map((t) => t.getAttribute('aria-label'));
    expect(new Set(areaNames).size).toBe(2);
    expect(areaNames.every((n) => n!.includes('후보 a'))).toBe(true);
    expect(group.querySelectorAll('textarea[data-slot="ds-textarea"]')).toHaveLength(2);
    for (const ta of Array.from(group.querySelectorAll('textarea'))) {
      expect(ta.getAttribute('aria-label')).toBeTruthy();
      // 이유 칸 면 = 내용 칸(panel) — 글 줄 면 위에 sunk를 얹지 않는다(층 표 · layer-rule.test.ts)
      expect(ta.classList.contains(VARIANT_REASON_FACE)).toBe(true);
      expect(ta.classList.contains('bg-ds-surface-sunk')).toBe(false);
    }
  });

  it('결정이 끝난 슬롯 · 보기만 하는 슬롯에는 라디오 묶음이 없다 — 선택 = «선택» 칩 + done 테두리, 반려 = «반려» 칩 + 점선', async () => {
    await mount({ loop: { status: 'executing' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'chosen', { choose_reason: '숫자가 좋아서' }), art('a2', 'rejected', { rejection_reason: '길어서' })] }] });
    expect(q('[role="radiogroup"]')).toBeNull();
    const tiles = qa('[data-slot="variant-tile"]');
    const chosen = tiles.find((t) => t.getAttribute('data-decision') === 'chosen')!;
    const rejected = tiles.find((t) => t.getAttribute('data-decision') === 'rejected')!;
    expect(chosen.className).toContain('border-ds-done');
    expect(chosen.textContent).toContain('선택');
    expect(chosen.textContent).toContain('숫자가 좋아서');
    expect(rejected.className).toContain('border-dashed');
    expect(rejected.textContent).toContain('반려');
    expect(rejected.textContent).toContain('길어서');
    expect(q('[data-slot="variant-slot"] [data-slot="ds-chip"][data-tone="done"]')).not.toBeNull();
  });

  it('슬롯 머리 = 상태 칩: 결정 중 = needs-hand 점 · 결정됨 = done 점', async () => {
    await mount(deciding);
    expect(q('[data-slot="variant-slot"] [data-slot="ds-section-header"] [data-slot="ds-chip"]')!.getAttribute('data-tone')).toBe('needs-hand');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ loop: { status: 'closed' }, groups: [{ variant_group: 'headline', artifacts: [art('a1', 'chosen'), art('a2', 'rejected')] }] });
    expect(q('[data-slot="variant-slot"] [data-slot="ds-section-header"] [data-slot="ds-chip"]')!.getAttribute('data-tone')).toBe('done');
  });
});

describe('[SID:4911] 루프 상세 — 옛 팔레트 0', () => {
  const LEGACY = /(^|[\s:])(?:[a-z-]+:)*(?:bg-(?:background|muted|secondary|primary|card|popover|accent|input)|border-(?:border|input)|text-(?:primary|muted-foreground|foreground|destructive)|[a-z-]*proof-[a-z-]+|bg-info-tint|border-info-border|text-info)(?![\w-])/;

  it('양성 대조: 이 정규식은 옛 클래스를 실제로 잡는다', () => {
    for (const c of ['bg-card', 'hover:bg-muted/50', 'border-border', 'text-muted-foreground', 'bg-proof-sunk', 'text-primary', 'bg-info-tint/40', 'text-destructive']) expect(LEGACY.test(c), c).toBe(true);
    for (const c of ['bg-ds-surface-high', 'text-ds-ink-3', 'border-ds-line', 'text-ds-info', 'bg-ds-info-soft']) expect(LEGACY.test(c), c).toBe(false);
  });

  it('⭐진짜 하위 부품까지 그린 DOM(결정 중 슬롯 · 과거 학습 · AI 블록)에 옛 팔레트 클래스가 없다', async () => {
    await mount({
      loop: { status: 'deciding', goal_tags: ['retention'], recipe_slug: 'r', parent_loop_id: 'abcdefgh1234', hypothesis_id: 'h1', brief_doc_id: 'd1' },
      groups: [{ variant_group: 'headline', artifacts: [art('a1', 'pending'), art('a2', 'pending'), art('a3', 'rejected', { rejection_reason: '길어' })] }],
      pack: PACK, hypothesis: '가설', brief: { id: 'd1', title: '브리프', slug: 'b' },
    });
    const classes = qa('*').map((n) => n.getAttribute('class') ?? '').filter(Boolean);
    expect(classes.length).toBeGreaterThan(60);
    expect(classes.filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('소스에도 옛 ui 부품 · 옛 팔레트 · lucide가 없다(상태 · 데이터가 없는 갈래까지)', () => {
    const root4 = join(__dirname, '..', '..', '..', '..', '..', '..'); // → src
    const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const files = [
      join(__dirname, 'loop-detail-client.tsx'),
      ...['variant-gallery', 'context-pack-panel', 'artifact-preview', 'ai-attribution'].map((f) => join(root4, 'components', 'loops', `${f}.tsx`)),
    ];
    for (const f of files) {
      const src = strip(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/from '@\/components\/ui\//);
      expect(src, f).not.toMatch(/from 'lucide-react'/);
      if (f.endsWith('artifact-preview.tsx')) expect(src, f).not.toContain('text-ds-ink-3'); // well 면 위 ink-3은 4.5:1 아래(layer-rule.test.ts)
      if (f.endsWith('ai-attribution.tsx')) expect(src, f).toContain('text-ds-ink-2'); // info-soft 위 투명성 줄
      expect(src, f).not.toMatch(/\b(?:bg-(?:background|muted|secondary|primary|card|popover|accent)|border-border|text-(?:muted-foreground|foreground|primary|destructive)|bg-info-tint|border-info-border)\b/);
    }
  });
});
