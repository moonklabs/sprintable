// @vitest-environment jsdom
//
// story 4831 부품 교체(에이전트 묶음) — 툴 권한 picker의 체크박스(코어 잠금 행 · 전체 선택 세 상태 행 · 그룹 행)가 바탕 Checkbox로 바뀌어도 동작이 그대로여야 한다.
// 지키는 것: ① 화면의 보이는 컨트롤은 role=checkbox 바탕 부품이다 ② 전체 행은 «일부 선택»이면 aria-checked=mixed이고, 누르면 날것 checkbox처럼 전체 선택이 된다
// ③ 그룹 행은 스페이스로 켜고 끈다(엔터는 아님) ④ 코어 잠금 행은 켜져 있고 눌러도 안 바뀐다.
// 되돌리면(날것 <input>으로) role=checkbox가 사라져 이 시험이 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TEMP_TOOLSET_CATALOG } from '@/lib/toolset-catalog';

vi.mock('@/lib/toolset-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/toolset-catalog')>();
  return { ...actual, fetchToolsetCatalog: async () => ({ catalog: actual.TEMP_TOOLSET_CATALOG, isFallback: false }) };
});

import { ToolPermissionPicker } from './tool-permission-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const agents = koMessages.agents as unknown as { toolPermissions: { selectAll: string; groups: Record<string, string> } };
const NORMAL = TEMP_TOOLSET_CATALOG.groups.filter((g) => !g.is_core && !g.is_destructive).map((g) => g.key);

const box = (label: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((b) => b.getAttribute('aria-label') === label)!;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const press = async (el: Element, key: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
};

let latest: string[] = [];
function Harness({ initial }: { initial: string[] }) {
  const [value, setValue] = useState(initial);
  useEffect(() => { latest = value; }, [value]);
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToolPermissionPicker value={value} onChange={setValue} />
    </NextIntlClientProvider>
  );
}
async function mount(initial: string[]) {
  await act(async () => { root.render(<Harness initial={initial} />); });
  await settle();
}

describe('ToolPermissionPicker — 바탕 Checkbox (story 4831 부품 교체)', () => {
  it('보이는 체크박스가 모두 바탕 부품(role=checkbox · data-slot=checkbox)이다', async () => {
    await mount([NORMAL[0]!]);
    const boxes = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    expect(boxes.length).toBeGreaterThanOrEqual(NORMAL.length + 2); // 코어 1 + 전체 1 + 그룹들
    expect(boxes.every((b) => b.getAttribute('data-slot') === 'checkbox')).toBe(true);
  });

  it('일부만 선택하면 «전체 선택» 행이 mixed이고, 그 행을 누르면 전체 비파괴 그룹이 선택된다(날짜 입력 아닌 날것 checkbox와 같은 동작)', async () => {
    await mount([NORMAL[0]!]);
    const all = box(agents.toolPermissions.selectAll);
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    await act(async () => { all.click(); });
    expect(latest.filter((k) => NORMAL.includes(k)).sort()).toEqual([...NORMAL].sort());
    expect(box(agents.toolPermissions.selectAll).getAttribute('aria-checked')).toBe('true');
  });

  it('전부 선택된 상태에서 전체 행을 누르면 비파괴 그룹이 모두 해제된다', async () => {
    await mount([...NORMAL]);
    expect(box(agents.toolPermissions.selectAll).getAttribute('aria-checked')).toBe('true');
    await act(async () => { box(agents.toolPermissions.selectAll).click(); });
    expect(latest.filter((k) => NORMAL.includes(k))).toEqual([]);
    expect(box(agents.toolPermissions.selectAll).getAttribute('aria-checked')).toBe('false');
  });

  it('그룹 행은 스페이스로 켜고 끈다(엔터로는 안 바뀐다)', async () => {
    await mount([NORMAL[0]!]);
    const key = NORMAL[1]!;
    const row = box(agents.toolPermissions.groups[key]!);
    expect(row.getAttribute('aria-checked')).toBe('false');
    row.focus();
    await press(row, 'Enter');
    expect(latest).not.toContain(key);
    await press(row, ' ');
    expect(latest).toContain(key);
    expect(box(agents.toolPermissions.groups[key]!).getAttribute('aria-checked')).toBe('true');
    await press(box(agents.toolPermissions.groups[key]!), ' ');
    expect(latest).not.toContain(key);
  });

  it('코어 잠금 행은 켜져 있고 비활성이며 눌러도 선택이 바뀌지 않는다', async () => {
    await mount([NORMAL[0]!]);
    const core = box(agents.toolPermissions.groups.core!);
    expect(core.getAttribute('aria-checked')).toBe('true');
    expect(core.hasAttribute('data-disabled') || core.getAttribute('aria-disabled') === 'true').toBe(true);
    const before = [...latest];
    await act(async () => { core.click(); });
    expect(latest).toEqual(before);
    expect(box(agents.toolPermissions.groups.core!).getAttribute('aria-checked')).toBe('true');
  });
});
