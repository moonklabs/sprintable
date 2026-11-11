// UI-3(a9d56577) — ds Menu 회귀가드: 역할 · 항목 상태 · 위험 항목 · 묶음 이름 · 폰 누름 영역 · 선택하면 onClick + 닫힘.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
import { Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './menu';
import { Kbd } from './kbd';

const items = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];

function Demo({ onOpenChange, onDelete, onRename }: { onOpenChange?: (o: boolean) => void; onDelete?: () => void; onRename?: () => void }) {
  return (
    <Menu open onOpenChange={onOpenChange}>
      <MenuTrigger>더보기</MenuTrigger>
      <MenuContent>
        <MenuGroup>
          <MenuLabel>문서</MenuLabel>
          <MenuItem icon="edit" shortcut={<Kbd>⌘E</Kbd>} onClick={onRename}>이름 바꾸기</MenuItem>
          <MenuItem disabled>복제</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem variant="danger" icon="delete" onClick={onDelete}>삭제</MenuItem>
      </MenuContent>
    </Menu>
  );
}

describe('ds Menu', () => {
  it('⭐role=menu 안에 menuitem이 있고 묶음에 이름이 이어진다(group + label)', async () => {
    await render(<Demo />);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(items().map((i) => i.textContent)).toEqual(['이름 바꾸기⌘E', '복제', '삭제']);
    const group = document.querySelector('[role="group"]') as HTMLElement;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('문서');
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('⭐상자 모양: 모서리 8 · surface-raised · line-control 경계 · 최소 폭 160', async () => {
    await render(<Demo />);
    const cls = (document.querySelector('[data-slot="ds-menu-content"]') as HTMLElement).className;
    expect(cls).toContain('rounded-ds-panel');
    expect(cls).toContain('bg-ds-surface-raised');
    expect(cls).toContain('border-ds-line-control');
    expect(cls).toContain('min-w-40');
  });

  it('⭐항목: 높이 32 · 폰 44 · 키보드 초점은 안쪽 링 · 비활성은 ink-3 + 눌림 없음', async () => {
    await render(<Demo />);
    const cls = items()[0]!.className;
    expect(cls).toContain('min-h-ds-compact');
    expect(cls).toContain('touch:min-h-ds-touch');
    expect(cls).toContain('focus-visible:ring-inset');
    expect(cls).toContain('focus-visible:ring-ds-action');
    expect(items()[1]!.getAttribute('aria-disabled')).toBe('true');
    expect(items()[1]!.className).toContain('data-disabled:text-ds-ink-3');
    expect(items()[1]!.className).toContain('data-disabled:pointer-events-none');
  });

  it('⭐위험 항목은 failed 글 · 아이콘이 붙고 기본 항목과 모양이 다르다', async () => {
    await render(<Demo />);
    expect(items()[2]!.className).toContain('text-ds-failed');
    expect(items()[2]!.getAttribute('data-variant')).toBe('danger');
    expect(items()[2]!.querySelector('[data-icon="delete"]')).not.toBeNull();
    expect(items()[0]!.className).toMatch(/(^|\s)text-ds-ink(\s|$)/);
    expect(items()[0]!.className).not.toContain('text-ds-failed');
  });

  it('항목을 누르면 그 항목의 onClick이 불리고 메뉴가 닫힘을 요청한다', async () => {
    const onOpenChange = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    await render(<Demo onOpenChange={onOpenChange} onRename={onRename} onDelete={onDelete} />);
    await act(async () => { items()[0]!.click(); });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls.at(-1)![0]).toBe(false);
  });

  it('비활성 항목을 눌러도 onClick이 안 불린다', async () => {
    const onClick = vi.fn();
    await render(<Menu open><MenuTrigger>t</MenuTrigger><MenuContent><MenuItem disabled onClick={onClick}>복제</MenuItem></MenuContent></Menu>);
    await act(async () => { items()[0]!.click(); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Esc로 닫힌다', async () => {
    const onOpenChange = vi.fn();
    await render(<Demo onOpenChange={onOpenChange} />);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onOpenChange.mock.calls.at(-1)![0]).toBe(false);
  });
});
