// @vitest-environment jsdom
//
// story 4892 (UI-9 문서 트리) — 문서 트리(폴더 보기 · 묶음 보기)가 ds 부품을 입는다. 동작은 그대로(접기 · 열기 · 우클릭 · 미리보기 · 끌기 · «⋮» 메뉴 · 이동 알림 · 지우기 · 이름 바꾸기):
// · 폴더 보기 줄 = ds TreeRow(줄 전체가 하나의 단추 · 폴더는 aria-expanded · 깊이당 16px · 36 / 폰 44) — 끌기 손잡이는 dnd 속성 그대로 TreeRow의 손잡이 자리에, «⋮»는 ds IconButton으로 오른쪽 자리에.
// · 묶음 보기 = ds SectionHeader(접는 머리글) + TreeRow 잎 + ds Button(«N개 더»).
// · 지우기 확인 = ds ConfirmDialog(위험) · 이름 바꾸기 = ds Dialog + Input + Button.
// · 검색 줄: «N개 문서 일치» · «검색 결과가 없어요»는 결과 목록 맨 위에 한 번만(찾기 칸 아래 것은 걷음).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DocTree } from './doc-tree';
import { DocAutoGroups } from './doc-auto-groups';
import { DocSearchResults } from './doc-search-results';
import { TreeSearchInput } from './tree-search-input';
import treeSource from './doc-tree.tsx?raw';
import groupsSource from './doc-auto-groups.tsx?raw';
import renameSource from './doc-rename-dialog.tsx?raw';
import layoutSource from '../../app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx?raw';
import viewPageSource from '../../app/(authenticated)/[ws]/[proj]/docs/[slug]/view/page.tsx?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ko = koMessages as unknown as Record<string, Record<string, string>>;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const intl = (n: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
const DOCS = [
  { id: 'f1', parent_id: null, title: '기획', slug: 'f1', icon: null, sort_order: 0, is_folder: true },
  { id: 'd1', parent_id: 'f1', title: '회의록', slug: 'd1', icon: null, sort_order: 0, status: 'draft' },
  { id: 'f2', parent_id: 'f1', title: '하위 폴더', slug: 'f2', icon: null, sort_order: 1, is_folder: true },
  { id: 'd2', parent_id: 'f2', title: '깊은 문서', slug: 'd2', icon: '📘', sort_order: 0 },
];
async function mountTree(over: Partial<React.ComponentProps<typeof DocTree>> = {}) {
  await act(async () => { root.render(intl(<DocTree docs={DOCS} selectedSlug="d1" onSelect={() => {}} onDelete={async () => {}} onRename={async () => {}} projectId="p1" {...over} />)); });
}
const rowOf = (id: string) => container.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)!.closest('[data-slot="ds-tree-row"]') as HTMLElement;
const ctl = (id: string) => container.querySelector<HTMLButtonElement>(`[data-doc-id="${id}"]`)!;
const openMenu = async (id: string) => { await act(async () => { rowOf(id).querySelector<HTMLElement>('[data-slot="ds-tree-trailing"] button')!.click(); }); };
const menu = () => document.querySelector<HTMLElement>('[data-dropdown-panel="doc-tree-menu"]');
const menuItem = (text: string) => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === text)!;

describe('폴더 보기 — 줄 = ds TreeRow (4892)', () => {
  it('⭐모든 줄이 ds TreeRow: 줄 전체가 하나의 단추(문서 줄에는 aria-expanded 없음 · 폴더 줄은 펼침 상태) · 깊이는 data-depth(뿌리 0 · 폴더 속 1 · 그 아래 2)', async () => {
    await mountTree();
    expect(container.querySelectorAll('[data-slot="ds-tree-row"]').length).toBe(4);
    expect(ctl('d1').tagName).toBe('BUTTON');
    expect(ctl('d1').hasAttribute('aria-expanded')).toBe(false);
    expect(ctl('f1').getAttribute('aria-expanded')).toBe('true');                                  // 폴더는 처음부터 펼친 채(지금 동작 그대로)
    expect(['f1', 'd1', 'f2', 'd2'].map((id) => rowOf(id).getAttribute('data-depth'))).toEqual(['0', '1', '1', '2']);
  });

  it('⭐지금 열린 문서만 aria-current="page" · 폴더 줄을 누르면 접히고(aria-expanded false · 자식 줄이 사라짐) 문서도 연다', async () => {
    const onSelect = vi.fn();
    await mountTree({ onSelect });
    expect(['f1', 'd1', 'f2', 'd2'].filter((id) => ctl(id).getAttribute('aria-current') === 'page')).toEqual(['d1']);
    await act(async () => { ctl('f1').click(); });
    expect(ctl('f1').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-doc-id="d1"]')).toBeNull();
    expect(onSelect).toHaveBeenCalledWith('f1');
  });

  it('⭐이모지가 있으면 이모지 · 없으면 폴더 / 열린 폴더 / 문서 아이콘 · 상태 점은 줄 단추 안(장식)', async () => {
    await mountTree();
    expect(ctl('d2').textContent).toContain('📘');
    expect(ctl('f1').querySelector('[data-icon="folder_open"]')).not.toBeNull();
    expect(ctl('d1').querySelector('[data-icon="description"]')).not.toBeNull();
    expect(ctl('d1').querySelector('[aria-hidden="true"].rounded-full')).not.toBeNull();            // 증명 상태 점
    await act(async () => { ctl('f2').click(); });
    expect(ctl('f2').querySelector('[data-icon="folder"]')).not.toBeNull();                         // 접힌 폴더 = 닫힌 폴더 아이콘
  });

  it('⭐줄 높이 36 · 폰 44(ds Button이 쥔 touch:min-h-ds-touch를 줄이 지우지 않음) · 줄 사이 틈 0(끌기 복제 이동량 36과 한 쌍)', async () => {
    await mountTree();
    const cls = ctl('d1').className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['min-h-ds-control', 'touch:min-h-ds-touch']));
    expect(cls).not.toContain('min-h-0');
    expect(container.querySelector('nav')!.className).not.toContain('space-y');
    expect(treeSource).toMatch(/transform\.y \+ 36/);
  });

  it('⭐끌기 손잡이: dnd 속성이 달린 같은 노드가 TreeRow 손잡이 자리에(마우스 전용 · tabIndex -1 · aria-hidden) · «⋮»는 ds IconButton으로 오른쪽 자리에(이름 = 문서 제목을 끼운 문구)', async () => {
    await mountTree();
    const row = rowOf('d1');
    const handle = row.querySelector<HTMLElement>('[data-slot="ds-tree-handle"] [data-drag-handle="mouse-only"]')!;
    expect(handle.getAttribute('aria-hidden')).toBe('true');
    expect(handle.tabIndex).toBe(-1);
    expect(handle.getAttribute('aria-roledescription')).not.toBeNull();                              // dnd-kit attributes still spread on it
    const more = row.querySelector<HTMLButtonElement>('[data-slot="ds-tree-trailing"] button')!;
    expect(more.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(more.getAttribute('aria-label')).toBe('회의록 메뉴 열기');
  });

  it('⭐미리보기 · 우클릭은 줄 단추가 그대로 받는다(우클릭 = 메뉴)', async () => {
    await mountTree();
    expect(menu()).toBeNull();
    await act(async () => { ctl('d1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(menu()).not.toBeNull();
  });

  it('⭐삽입선 · 빈 폴더 글의 들여쓰기가 새 줄 표(깊이당 16px)에서 나온다 — 옛 14px 식이 남지 않음', () => {
    expect(treeSource).toContain('treeIndentPx(depth) + 8');
    expect(treeSource).toContain('treeIndentPx(depth + 1)');
    expect(treeSource).not.toMatch(/depth \* 14/);
    expect(treeSource).not.toMatch(/\(depth \+ 1\) \* 14/);
  });
});

describe('행 메뉴 · 창 — ds 부품 (4892)', () => {
  it('⭐메뉴 항목은 전부 ds Button(조용 변형) — 옛 ui Button · 옛 토큰 없음 · 키 약속(열면 첫 항목 초점 · 꺼진 항목도 초점은 받음)은 그대로', async () => {
    await mountTree({ onMenuMove: async () => null });
    await openMenu('d1');
    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const el of items) expect(el.getAttribute('data-slot'), el.textContent ?? '').toBe('ds-button');
    expect(menu()!.className).toContain('bg-ds-surface-raised');
    expect(document.activeElement).toBe(items.find((e) => e.getAttribute('aria-disabled') !== 'true'));
    const disabled = items.find((e) => e.getAttribute('aria-disabled') === 'true');
    if (disabled) { disabled.focus(); expect(document.activeElement).toBe(disabled); }
  });

  it('⭐지우기 = ds ConfirmDialog(위험 단추) — 처음 초점은 «취소»(Enter 한 번으로 지우지 않게) · 누르면 onDelete', async () => {
    const onDelete = vi.fn(async () => {});
    await mountTree({ onDelete });
    await openMenu('d1');
    await act(async () => { menuItem(ko.docs!.docTreeDelete!).click(); });
    const dialog = document.querySelector<HTMLElement>('[data-slot="ds-dialog-content"]')!;
    expect(dialog).not.toBeNull();
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-slot="ds-button"]')];
    expect(buttons.map((b) => b.textContent)).toEqual([ko.docs!.cancel, ko.docs!.deleteDoc]);
    expect(buttons[1]!.className).toContain('border-ds-failed');                                     // 위험 모양(tone="danger")
    expect(buttons[1]!.className).not.toContain('bg-ds-action');
    await act(async () => { buttons[1]!.click(); });
    expect(onDelete).toHaveBeenCalledWith('d1');
  });

  it('⭐이름 바꾸기 = ds Dialog + ds Input + ds Button — 저장은 새 이름일 때만 켜짐 · 저장하면 onRename', async () => {
    const onRename = vi.fn(async () => {});
    await mountTree({ onRename });
    await openMenu('d1');
    await act(async () => { menuItem(ko.docs!.docTreeRename!).click(); });
    const dialog = document.querySelector<HTMLElement>('[data-testid="doc-rename-dialog"]')!;
    expect(dialog.getAttribute('data-slot')).toBe('ds-dialog-content');
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="doc-rename-input"]')!;
    expect(input.getAttribute('data-slot')).toBe('ds-input');
    const save = dialog.querySelector<HTMLButtonElement>('[data-testid="doc-rename-save"]')!;
    expect(save.getAttribute('data-slot')).toBe('ds-button');
    expect(save.className).toContain('bg-ds-action');                                                  // 저장 = 주 단추(primary) · 취소 = 보조
    expect(dialog.querySelector<HTMLButtonElement>('button:not([data-testid="doc-rename-save"])[data-slot="ds-button"]')!.className).not.toContain('bg-ds-action');
    expect(save.disabled).toBe(true);                                                                 // 이름이 그대로면 잠김
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '새 이름'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(onRename).toHaveBeenCalledWith('d1', '새 이름');
  });

  it('두 화면(폴더 · 묶음)과 이름 창에 옛 ui/ · lucide · 옛 토큰이 없다', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');    // 주석 속 옛 이름 설명은 걷고 본다
    for (const [name, src0] of [['doc-tree', treeSource], ['doc-auto-groups', groupsSource], ['doc-rename-dialog', renameSource]] as const) {
      const src = code(src0);
      expect(src, `${name}: 옛 ui/`).not.toMatch(/from '@\/components\/ui\//);
      expect(src, `${name}: lucide`).not.toMatch(/lucide-react/);
      expect(src, `${name}: 옛 토큰`).not.toMatch(/\b(?:text-muted-foreground|bg-muted|border-border|bg-popover|text-foreground|bg-primary)\b/);
    }
  });
});

describe('묶음 보기 — ds SectionHeader + TreeRow (4892)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, slug: `policy-${i}`, parent_id: null as string | null, title: `정책 ${i}` }));
  const LABELS = { inFolderLabel: '폴더에 담김', looseAtRootLabel: '폴더 밖', thisMonthLabel: '이번 달', lastMonthLabel: '지난 달', olderLabel: '이전', unknownDateLabel: '날짜 없음', moreLabel: (c: number) => `${c}개 더` };

  it('⭐묶음 머리 = ds SectionHeader(접는 단추 · aria-expanded 처음엔 false · 이름과 개수) → 펼치면 문서 줄 = TreeRow 잎(열린 문서만 aria-current) · 8개 넘으면 ds Button «N개 더»', async () => {
    const onSelect = vi.fn();
    await act(async () => { root.render(<DocAutoGroups docs={many(11)} selectedSlug="policy-1" onSelect={onSelect} {...LABELS} />); });
    const header = container.querySelector<HTMLElement>('[data-slot="ds-section-header"]')!;
    expect(header).not.toBeNull();
    const toggle = header.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('11');
    expect(container.querySelector('[data-slot="ds-tree-row"]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="ds-tree-row"]')];
    expect(rows.length).toBe(8);                                                                      // MEMBER_CAP
    expect(rows.every((r) => r.querySelector('button')!.getAttribute('aria-expanded') === null)).toBe(true);   // 잎 줄
    expect(rows.filter((r) => r.querySelector('button')!.getAttribute('aria-current') === 'page').length).toBe(1);
    const more = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="ds-button"]')].find((b) => b.textContent === '3개 더')!;
    expect(more).not.toBeUndefined();
    await act(async () => { rows[2]!.querySelector('button')!.click(); });
    expect(onSelect).toHaveBeenCalledWith('policy-2');
    await act(async () => { more.click(); });
    expect(container.querySelectorAll('[data-slot="ds-tree-row"]').length).toBe(11);
  });
});

describe('검색 줄 — 개수 줄 · «결과 없음» 줄은 한 번만 (4892)', () => {
  const RESULTS = [
    { id: 'r1', title: '결제 정책', slug: 'pay', icon: null, snippet: null },
    { id: 'r2', title: '환불 정책', slug: 'refund', icon: null, snippet: null },
  ] as unknown as React.ComponentProps<typeof DocSearchResults>['results'];
  const column = (results: React.ComponentProps<typeof DocSearchResults>['results'], loading = false) => (
    <>
      <TreeSearchInput value="정책" onChange={() => {}} onClear={() => {}} isSearching placeholder="검색" clearLabel="지우기" />
      <DocSearchResults results={results} loading={loading} selectedSlug={null} onSelect={() => {}} loadingLabel="불러오는 중" noResultsLabel="없음" resultCountLabel={(n) => `${n}건`} cappedLabel="더" cap={50} />
    </>
  );
  const count = (needle: string) => (container.textContent ?? '').split(needle).length - 1;

  it('⭐결과가 있으면 «N건» 한 번 · 없으면 «없음» 한 번 · 기다리는 동안엔 «없음»이 먼저 뜨지 않는다(찾기 칸 아래 줄이 걷혀서)', async () => {
    await act(async () => { root.render(column(RESULTS)); });
    expect(count('2건')).toBe(1);
    await act(async () => { root.render(column([] as never)); });
    expect(count('없음')).toBe(1);
    await act(async () => { root.render(column([] as never, true)); });
    expect(count('없음')).toBe(0);
    expect(count('불러오는 중')).toBe(1);
  });

  it('호출부(레이아웃)가 찾기 칸에 개수 · 결과 없음 문구를 넘기지 않는다 — 결과 목록에만', () => {
    const call = layoutSource.slice(layoutSource.indexOf('<TreeSearchInput'), layoutSource.indexOf('/>', layoutSource.indexOf('<TreeSearchInput')));
    expect(call).not.toMatch(/matchCount|resultCountLabel|noResultsLabel/);
    expect(layoutSource.match(/resultCountLabel=/g)?.length).toBe(1);
    expect(layoutSource.match(/noResultsLabel=/g)?.length).toBe(1);
  });
});

describe('문서 읽기 화면 — 「터치」 변형 (4892 · PO 11-11)', () => {
  it('문서 읽기 화면 «⋮» 단추는 pointer-coarse가 아니라 touch: 변형으로 폰 44를 연다', () => {
    expect(viewPageSource).toContain('touch:size-11');
    expect(viewPageSource).not.toContain('pointer-coarse:');
  });
});
