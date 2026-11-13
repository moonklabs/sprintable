// @vitest-environment jsdom
//
// story 4911 (실행 목록 재건축) — 구조 단언. 되돌리면(옛 칩 줄 · 한 줄 카드 · 옛 팔레트) 빨개지는 것만 둔다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { LAYER } from '@/components/ds/layers';
import { LOOP_FILTER_STICKY, LOOP_ROW_FACE } from './loops-layer';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/components/loops/loop-create-dialog', () => ({ LoopCreateDialog: () => null }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div data-testid="topbar">{title}{actions}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = 'draft' | 'briefing' | 'generating' | 'deciding' | 'executing' | 'measuring' | 'closed' | 'abandoned';
const mk = (id: string, status: Status, extra: Record<string, unknown> = {}) => ({
  id, project_id: 'proj-1', parent_loop_id: null, hypothesis_id: null, brief_doc_id: null, recipe_slug: null,
  title: `실행 ${id}`, goal_tags: [], status, outcome_snapshot: null, created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', ...extra,
});
const DATA = [
  mk('a', 'executing', { goal_tags: ['retention'] }),
  mk('b', 'deciding', { goal_tags: ['retention', 'growth'], parent_loop_id: '1234567890abcdef', recipe_slug: 'weekly-signup' }),
  mk('c', 'closed', { outcome_snapshot: { hypothesis_status: 'verified' } }),
  mk('d', 'draft'),
  mk('e', 'abandoned'),
];

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>
);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => DATA }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { LoopsClient } = await import('./loops-client');
  await act(async () => { root.render(wrap(<LoopsClient projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => Array.from(container.querySelectorAll<HTMLElement>(sel));
const section = (id: string) => q(`[data-testid="loops-section-${id}"]`);

describe('[SID:4911] 실행 목록 — 구획 · 행', () => {
  it('«전체»에서는 상태로 세 구획에 묶인다: 결정이 필요한 것 → 진행 중 → 끝난 것 (구획 순서 · 수 · 행 소속)', async () => {
    await mount();
    const ids = qa('[data-testid^="loops-section-"]').map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['loops-section-decide', 'loops-section-progress', 'loops-section-finished']);
    const rowsIn = (id: string) => Array.from(section(id)!.querySelectorAll('[data-loop-row-status]')).map((e) => e.getAttribute('data-loop-row-status'));
    expect(rowsIn('decide')).toEqual(['deciding']);
    expect(rowsIn('progress').sort()).toEqual(['draft', 'executing']);
    expect(rowsIn('finished').sort()).toEqual(['abandoned', 'closed']);
    expect(section('decide')!.textContent).toContain('결정이 필요한 것');
    expect(section('progress')!.textContent).toContain('진행 중');
    expect(section('finished')!.textContent).toContain('끝난 것');
    // 구획 머리 = 제목 + 건수 배지(수를 제목 문자열에 넣지 않는다)
    expect(section('progress')!.querySelector('[data-slot="ds-count-badge"]')!.textContent).toBe('2');
  });

  it('빈 구획은 그리지 않는다(결정이 필요한 것이 없으면 그 머리도 없다)', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => [mk('a', 'executing')] }));
    await mount();
    expect(qa('[data-testid^="loops-section-"]').map((e) => e.getAttribute('data-testid'))).toEqual(['loops-section-progress']);
  });

  it('행 = 제목 + 단계 막대 + 상태 칩 + 태그 칩 · 계보/레시피는 둘째 줄 · 종료 행은 성과 칩', async () => {
    await mount();
    const b = q('[data-testid="loop-row-b"]')!;
    expect(b.textContent).toContain('실행 b');
    expect(b.querySelector('[data-slot="loop-stage-bar"]')).not.toBeNull();
    expect(b.querySelector('[data-loop-status="deciding"]')!.textContent).toBe('결정 중');
    expect(Array.from(b.querySelectorAll('[data-slot="ds-chip"]')).map((c) => c.textContent)).toEqual(expect.arrayContaining(['retention', 'growth']));
    expect(b.textContent).toContain('#12345678에서 파생');
    expect(b.textContent).toContain('weekly-signup');
    const c = q('[data-testid="loop-row-c"]')!;
    expect(c.querySelector('[data-outcome="hit"]')!.textContent).toContain('적중');
    expect(q('[data-testid="loop-row-a"]')!.querySelector('[data-outcome]')).toBeNull();
  });

  it('행 얼굴 = 남의 글 줄 층(LAYER.rowOthers) — 내용 칸(패널) 위에서 갈린다', async () => {
    await mount();
    expect(LOOP_ROW_FACE).toBe(LAYER.rowOthers);
    // 호버 = 한 단 위 면 + 둘째 줄이 ink-2로(ink-3은 그 면 위에서 4.5:1 아래 — layer-rule.test.ts)
    const rowCls = q('[data-testid="loop-row-a"] [data-slot="ds-list-row"]')!.className;
    expect(rowCls).toContain('hover:bg-ds-surface-highest');
    expect(rowCls).toContain('hover:[&_div.font-mono]:text-ds-ink-2');
    for (const id of ['a', 'b', 'c']) {
      const row = q(`[data-testid="loop-row-${id}"] [data-slot="ds-list-row"]`)!;
      expect(row.className).toContain('bg-ds-surface-high');
    }
    // 구획 패널은 ds Card(내용 칸)다
    expect(section('progress')!.getAttribute('data-slot')).toBe('ds-row-list');
  });
});

describe('[SID:4911] 실행 목록 — 걸러보기(«단계» 하나)', () => {
  it('거르기 길은 «단계» 고르기 하나(칩 줄이 아니다): 아홉 값 · 칩 단추 없음 · aria-pressed 단추 없음', async () => {
    await mount();
    const select = q('[data-testid="loops-status-filter"]') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['all', 'draft', 'briefing', 'generating', 'deciding', 'executing', 'measuring', 'closed', 'abandoned']);
    expect(select.closest('label')!.textContent).toContain('단계');
    expect(qa('button[aria-pressed]')).toHaveLength(0);
  });

  it('단계를 고르면 그 단계로 다시 불러오고(status=…) 구획 없이 평평한 한 목록이다', async () => {
    await mount();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => [mk('b', 'deciding')] }));
    const select = q('[data-testid="loops-status-filter"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'deciding';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('status=deciding');
    expect(qa('[data-testid^="loops-section-"]')).toHaveLength(0);
    expect(qa('[data-testid="loops-flat-list"] [data-testid^="loop-row-"]')).toHaveLength(1);
  });

  it('고른 단계가 0건이면 «아직 시작한 실행이 없어요»가 아니라 그 단계가 비었다고만 말한다', async () => {
    await mount();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => [] }));
    const select = q('[data-testid="loops-status-filter"]') as HTMLSelectElement;
    await act(async () => { select.value = 'measuring'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('이 단계의 실행이 없어요');
    expect(container.textContent).not.toContain('아직 시작한 실행이 없어요');
  });
});

describe('[SID:4911] 실행 목록 — 여는 길(클릭 · Enter · Space)', () => {
  it('행 클릭 = 열기', async () => {
    await mount();
    await act(async () => { q('[data-testid="loop-row-b"] [data-slot="ds-list-row"]')!.click(); });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/loops/b');
  });

  it('진짜 더블클릭(클릭 · 클릭 · dblclick)은 이동을 한 번만 한다', async () => {
    await mount();
    const row = q('[data-testid="loop-row-b"] [data-slot="ds-list-row"]')!;
    await act(async () => {
      row.click(); row.click();
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('더블클릭은 또 열지 않는다(행 부품의 더블클릭 열기를 막음 — 첫 클릭이 이미 열었다)', async () => {
    await mount();
    await act(async () => { q('[data-testid="loop-row-b"] [data-slot="ds-list-row"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('행에 초점이 있을 때 Enter = 열기 · Space = 열기(role=button 그대로)', async () => {
    await mount();
    const row = q('[data-testid="loop-row-a"] [data-slot="ds-list-row"]')!;
    expect(row.getAttribute('role')).toBe('button');
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith('/ws-1/proj-1/loops/a');
    pushMock.mockClear();
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 5000); // past the double-open guard window
    // Space: keydown is swallowed (the page does not scroll) and arms the row, keyup opens it
    const down = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    await act(async () => { row.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })); });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith('/ws-1/proj-1/loops/a');
    nowSpy.mockRestore();
  });

  it('Space 장전은 초점이 떠나면 풀린다: 누르고 → 초점 이탈 → 같은 줄에서 뗀 keyup은 열지 않는다', async () => {
    await mount();
    const a = q('[data-testid="loop-row-a"] [data-slot="ds-list-row"]')!;
    await act(async () => { a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    await act(async () => { a.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await act(async () => { a.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })); });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('Space는 누른 그 줄에서 뗄 때만 열린다: 누르지 않은 keyup · 누른 채 초점이 옮겨 간 다른 줄 keyup은 열지 않는다', async () => {
    await mount();
    const a = q('[data-testid="loop-row-a"] [data-slot="ds-list-row"]')!;
    const d = q('[data-testid="loop-row-d"] [data-slot="ds-list-row"]')!;
    await act(async () => { a.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })); });
    expect(pushMock).not.toHaveBeenCalled();
    await act(async () => { a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    await act(async () => { d.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })); });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('↑↓로 행을 옮긴다 — 탭 정지는 행 하나(목록 한 개당)', async () => {
    await mount();
    const list = section('progress')!;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-row-main]'));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.tabIndex).sort()).toEqual([-1, 0]);
    rows[0]!.focus();
    await act(async () => { rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe('[SID:4911] 실행 목록 — 못 불러온 것 ≠ 실행 없음', () => {
  it('목록 호출이 실패하면 «아직 시작한 실행이 없어요»(빈 상태) 대신 오류 띠 + 다시 시도', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    expect(container.textContent).toContain('실행 목록을 불러오지 못했어요');
    expect(container.textContent).not.toContain('아직 시작한 실행이 없어요');
    expect(q('[role="alert"]')).not.toBeNull();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => DATA }));
    const retry = qa('button').find((b) => b.textContent === '다시 시도')!;
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(q('[role="alert"]')).toBeNull();
    expect(qa('[data-testid^="loop-row-"]')).toHaveLength(5);
    err.mockRestore();
  });

  it('단계를 바꾼 뒤 호출이 실패하면 앞 단계의 행을 남겨 두지 않는다(오류 띠만)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    expect(qa('[data-testid^="loop-row-"]')).toHaveLength(5);
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const select = q('[data-testid="loops-status-filter"]') as HTMLSelectElement;
    await act(async () => { select.value = 'closed'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(q('[role="alert"]')).not.toBeNull();
    expect(qa('[data-testid^="loop-row-"]')).toHaveLength(0);
    err.mockRestore();
  });

  it('단계를 연달아 바꿨을 때 늦게 온 옛 답이 지금 단계의 행을 덮지 않는다', async () => {
    await mount();
    const resolvers: Array<(v: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    const select = q('[data-testid="loops-status-filter"]') as HTMLSelectElement;
    await act(async () => { select.value = 'closed'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { select.value = 'draft'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(resolvers).toHaveLength(2);
    // newest answer first, the older one late
    await act(async () => { resolvers[1]!({ ok: true, json: async () => [mk('d', 'draft')] }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { resolvers[0]!({ ok: true, json: async () => [mk('c', 'closed')] }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(qa('[data-testid^="loop-row-"]').map((r) => r.getAttribute('data-testid'))).toEqual(['loop-row-d']);
  });

  it('이 화면이 모르는 새 상태도 «전체»에서 사라지지 않고 진행 중에 서며, 칩은 상태 값을 그대로 보여 준다', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => [mk('z', 'queued' as unknown as Status), mk('b', 'deciding')] }));
    await mount();
    const row = section('progress')!.querySelector('[data-testid="loop-row-z"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-slot="ds-chip"]')!.textContent).toBe('queued');
    expect(row.querySelector('[data-slot="loop-stage-bar"]')).toBeNull();
  });

  it('진짜 0건(전체)이면 첫 만남 정체성 빈 상태가 그대로 나온다(가설 → 실행 → 검증 → 학습 · 첫 실행 시작하기)', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => [] }));
    await mount();
    expect(container.textContent).toContain('아직 시작한 실행이 없어요');
    expect(container.textContent).toContain('첫 실행 시작하기');
    expect(container.textContent).toContain('다음 실행');
  });
});

describe('[SID:4911] 실행 목록 — 옛 팔레트 0', () => {
  const LEGACY = /(^|[\s:])(?:[a-z-]+:)*(?:bg-(?:background|muted|secondary|primary|card|popover|accent|input)|border-(?:border|input)|text-(?:primary|muted-foreground|foreground)|[a-z-]*proof-[a-z-]+)(?![\w-])/;

  it('양성 대조: 이 정규식은 옛 클래스를 실제로 잡는다', () => {
    for (const c of ['bg-card', 'hover:bg-muted/50', 'border-border', 'text-muted-foreground', 'bg-proof-sunk', 'text-primary']) expect(LEGACY.test(c), c).toBe(true);
    for (const c of ['bg-ds-surface-high', 'text-ds-ink-3', 'border-ds-line']) expect(LEGACY.test(c), c).toBe(false);
  });

  it('데이터가 있는 목록 · 빈 목록 · 오류 상태의 렌더 안 클래스에 옛 팔레트가 없다', async () => {
    await mount();
    const classes = qa('*').map((n) => n.getAttribute('class') ?? '').filter(Boolean);
    expect(classes.length).toBeGreaterThan(20);
    expect(classes.filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('소스에도 옛 ui 부품 · 옛 팔레트가 없다(데이터 없는 상태까지)', () => {
    const dir = join(__dirname);
    const comps = join(__dirname, '..', '..', '..', '..', '..', 'components', 'loops');
    const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const f of [join(dir, 'loops-client.tsx'), join(comps, 'loop-status-badge.tsx'), join(comps, 'outcome-badge.tsx'), join(comps, 'loop-stage-bar.tsx')]) {
      const src = strip(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/from '@\/components\/ui\/(?:badge|button|empty-state|select|input|dialog)'/);
      expect(src, f).not.toMatch(/\b(?:bg-(?:background|muted|secondary|primary|card|popover|accent)|border-border|text-muted-foreground)\b/);
      expect(src, f).not.toMatch(/from 'lucide-react'/);
    }
  });
});

describe('[SID:4911] 실행 목록 — 틀', () => {
  it('본문은 한 쪽 틀(wide)이고 제목은 상단 막대 h1 하나다 · «새 실행 시작하기»는 상단 막대에 그대로', async () => {
    await mount();
    expect(q('[data-slot="ds-page-frame"]')!.getAttribute('data-width')).toBe('wide');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const add = q('[data-testid="topbar"] button')!;
    expect(add.getAttribute('aria-label')).toBe('새 실행 시작하기');
    expect(add.getAttribute('data-slot')).toBe('ds-button');
  });

  it('거르기 줄은 옛 목록처럼 스크롤해도 맨 위에 붙는다(sticky top-0) · 바탕은 쪽 바탕 층이다', async () => {
    await mount();
    const bar = q('[data-slot="ds-filter-bar"]')!.parentElement!;
    for (const c of LOOP_FILTER_STICKY.split(' ')) expect(bar.classList.contains(c), c).toBe(true);
    expect(bar.classList.contains('sticky')).toBe(true);
    expect(bar.classList.contains('top-0')).toBe(true);
    expect(LOOP_FILTER_STICKY).toContain(LAYER.page);
  });

  it('건수 줄 · 키 안내(↑↓ Enter)는 데스크톱 폭에서만 보인다(좁은 폭은 숨김 클래스)', async () => {
    await mount();
    const line = q('[data-testid="loops-count-line"]')!;
    expect(line.textContent).toContain('5개');
    const hint = line.querySelector('.max-lg\\:hidden')!;
    expect(hint.textContent).toContain('이동');
    expect(hint.textContent).toContain('Enter');
  });
});
