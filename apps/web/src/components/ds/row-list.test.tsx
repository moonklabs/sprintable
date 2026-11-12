// 4913(UI-R5) RowList · RowListItem — 구획 머리 + 행이 한 패널 안, 행 우클릭 = 그 행 «⋯» 메뉴와 같은 항목, ↑↓ Enter Esc, 행 안 펼침(한 단 올린 면).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LAYER } from './layers';
import { RowList, RowListItem, type RowAction } from './row-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

const render = (n: ReactNode) => act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={{ common: { close: '닫기' } }}>{n}</NextIntlClientProvider>); });
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-row-main]')];
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

const ACTIONS: RowAction[] = [
  { key: 'manage', label: '연결 관리', onSelect: vi.fn() },
  { key: 'cred', label: '앱 자격', icon: 'edit', onSelect: vi.fn() },
  { key: 'del', label: '해제', variant: 'danger', separatorBefore: true, onSelect: vi.fn() },
];

function Demo({ withActions = true, onSelect }: { withActions?: boolean; onSelect?: (k: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const actions = ACTIONS.map((a) => ({ ...a, onSelect: () => onSelect?.(a.key) }));
  return (
    <RowList aria-label="채널" header={{ title: '채널', trailing: 3 }}>
      {['a', 'b', 'c'].map((id) => {
        const common = {
          'data-testid': `row-${id}`,
          title: `행 ${id}`,
          subtitle: `부제 ${id}`,
          statusMark: <span>상태</span>,
          expanded: open === id,
          onExpandedChange: (v: boolean) => setOpen(v ? id : null),
          detail: <div data-testid={`detail-${id}`}><input aria-label="입력" /></div>,
        };
        return withActions && id !== 'c'
          ? <RowListItem key={id} {...common} actions={actions} actionsLabel="더보기" />
          : <RowListItem key={id} {...common} />;
      })}
    </RowList>
  );
}

describe('ds RowList', () => {
  it('⭐구획 머리 + 행이 «한 패널(Card)» 안에 선다 · 목록 이름 · 행 role', async () => {
    await render(<Demo />);
    const card = container.querySelector('[data-slot="ds-row-list"]')!;
    expect(card.getAttribute('data-slot')).toBe('ds-row-list');
    expect(card.querySelector('[data-slot="ds-section-header"]')?.textContent).toContain('채널');
    const list = card.querySelector('[role="list"]')!;
    expect(list.getAttribute('aria-label')).toBe('채널');
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    expect(card.className).toContain('bg-ds-surface'); // 패널 층(Card) — 바탕 위에서 한 단 올라온다
  });

  it('⭐행 우클릭 = 그 행 «⋯» 메뉴와 같은 항목(같은 배열) — 순서 · 글 모두 같다', async () => {
    await render(<Demo />);
    const trigger = container.querySelector('[data-testid="row-a"] [data-slot="ds-row-context-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 2 })); });
    const viaContext = menuLabels();
    expect(viaContext).toEqual(['연결 관리', '앱 자격', '해제']);
    await key(document.activeElement ?? document.body, 'Escape');
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // «⋯» 단추로 연 메뉴
    const more = container.querySelector('[data-testid="row-a"] [data-slot="ds-row-actions-trigger"]') as HTMLElement;
    await act(async () => { more.click(); });
    expect(menuLabels()).toEqual(viaContext);
  });

  it('⭐항목을 고르면 그 행동의 onSelect가 불린다(우클릭 길)', async () => {
    const onSelect = vi.fn();
    await render(<Demo onSelect={onSelect} />);
    const trigger = container.querySelector('[data-testid="row-b"] [data-slot="ds-row-context-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 })); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === '앱 자격')!;
    await act(async () => { item.click(); });
    expect(onSelect).toHaveBeenCalledWith('cred');
  });

  it('⭐«⋯»가 없는 행(actions 없음)은 우클릭 래퍼도 «⋯» 단추도 없다 — 브라우저 기본 메뉴 그대로', async () => {
    await render(<Demo />);
    const c = container.querySelector('[data-testid="row-c"]')!;
    expect(c.querySelector('[data-slot="ds-row-context-trigger"]')).toBeNull();
    expect(c.querySelector('[data-slot="ds-row-actions-trigger"]')).toBeNull();
    const a = container.querySelector('[data-testid="row-a"]')!;
    expect(a.querySelector('[data-slot="ds-row-actions-trigger"]')?.getAttribute('aria-label')).toBe('더보기');
  });

  it('⭐키보드: ↑↓ 행 옮기기 · Home/End · 끝에서 멈춤', async () => {
    await render(<Demo />);
    const [a, b, c] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    a.focus();
    await key(a, 'ArrowDown'); expect(document.activeElement).toBe(b);
    await key(b, 'ArrowDown'); expect(document.activeElement).toBe(c);
    await key(c, 'ArrowDown'); expect(document.activeElement).toBe(c);
    await key(c, 'ArrowUp'); expect(document.activeElement).toBe(b);
    await key(b, 'Home'); expect(document.activeElement).toBe(a);
    await key(a, 'End'); expect(document.activeElement).toBe(c);
  });

  it('⭐탭 정지는 행 하나뿐이다(roving) — 초점이 간 행으로 옮겨 간다', async () => {
    await render(<Demo />);
    const tabbable = () => rows().filter((r) => r.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(rows()[0]);
    rows()[2]!.focus();
    expect(tabbable()).toEqual([rows()[2]]);
  });

  it('⭐Enter = 펼침/접힘 · Esc = 닫기 · 펼침은 한 번에 하나(호출부 상태)', async () => {
    await render(<Demo />);
    const [a, b] = rows() as [HTMLElement, HTMLElement];
    a.focus();
    await key(a, 'Enter');
    expect(container.querySelector('[data-testid="detail-a"]')).not.toBeNull();
    await key(b, 'Enter');
    expect(container.querySelector('[data-testid="detail-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="detail-b"]')).not.toBeNull();
    await key(b, 'Escape');
    expect(container.querySelector('[data-testid="detail-b"]')).toBeNull();
    await key(b, 'Enter');
    await key(b, 'Enter');
    expect(container.querySelector('[data-testid="detail-b"]')).toBeNull();
  });

  it('⭐펼친 칸 안 입력에서 누른 Esc/Enter는 행을 접거나 펴지 않는다(글 입력을 가로채지 않는다)', async () => {
    await render(<Demo />);
    const a = rows()[0]!;
    a.focus();
    await key(a, 'Enter');
    const input = container.querySelector('[data-testid="detail-a"] input') as HTMLElement;
    await key(input, 'Escape');
    expect(container.querySelector('[data-testid="detail-a"]')).not.toBeNull();
    await key(input, 'Enter');
    expect(container.querySelector('[data-testid="detail-a"]')).not.toBeNull();
  });

  it('⭐펼침 칸은 한 단 올린 면(LAYER.rowOthers) · 행 줄 «밖»(형제)에 있다', async () => {
    await render(<Demo />);
    const a = rows()[0]!;
    await key(a, 'Enter');
    const detail = container.querySelector('[data-slot="ds-row-detail"]')!;
    expect(detail.className).toContain(LAYER.rowOthers);
    expect(detail.previousElementSibling?.querySelector('[data-slot="ds-list-row"]') ?? detail.previousElementSibling).not.toBeNull();
    expect(container.querySelector('[data-testid="row-a"]')!.contains(detail)).toBe(true);
    expect(container.querySelector('[data-testid="row-a"]')!.getAttribute('data-open')).toBe('true');
  });

  it('expandLabel을 주면 기본 펼침 단추(aria-expanded · aria-controls)가 선다', async () => {
    function One() {
      const [e, setE] = useState(false);
      return <RowList aria-label="x"><RowListItem title="t" expandLabel="자세히" expanded={e} onExpandedChange={setE} detail={<div>상세</div>} /></RowList>;
    }
    await render(<One />);
    const btn = container.querySelector('button[aria-label="자세히"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { btn.click(); });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-controls')).toBe(container.querySelector('[data-slot="ds-row-detail"]')!.id);
  });
});
