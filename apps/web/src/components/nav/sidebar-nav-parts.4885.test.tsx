// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Home } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const { SidebarProvider, SidebarMenu } = await import('@/components/ui/sidebar');
const { NavGroupHeader, NavRow } = await import('./sidebar-nav-parts');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <SidebarProvider>
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarProvider>
    </NextIntlClientProvider>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('sidebar-nav-parts (4885) — 길잡이 줄·묶음 머리는 한 자리에서만 만든다', () => {
  it('app-sidebar.tsx는 줄·머리의 모양을 직접 모른다(NavRow · NavGroupHeader만 쓴다)', () => {
    const src = read('app-sidebar.tsx');
    expect(src).toContain('<NavRow');
    expect(src).toContain('<NavGroupHeader');
    expect(src).not.toMatch(/<SidebarMenuButton/);
    expect(src).not.toMatch(/<SidebarGroupLabel/);
    expect(src).not.toMatch(/<SidebarMenuItem/);
    expect(src).not.toMatch(/function (KbdHint|ScopeMark)/);
  });

  it('줄 모양은 sidebar-nav-parts.tsx 한 파일에 있다', () => {
    const src = read('sidebar-nav-parts.tsx');
    expect(src).toContain('<ListRow');
    expect(src).toContain('density="compact"');
    expect(src).toContain('<SectionHeader');
  });

  it('NavRow: 이름 · 범위 표식 · 키 · 배지(상한 넘으면 N+)를 그리고, 0이면 배지·표식이 없다', () => {
    act(() => root.render(
      <Frame>
        <NavRow href="/x" label="결재" Icon={Home} isActive={false} scopeMark="프로젝트" kbd="K" badgeCount={12} badgeCap={9} />
      </Frame>,
    ));
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/x');
    expect(host.textContent).toContain('결재');
    expect(host.textContent).toContain('프로젝트');
    expect(host.querySelector('kbd')?.textContent).toBe('K');
    expect(host.textContent).toContain('9+');
    expect(host.querySelector('[data-slot="ds-count-badge"]')?.getAttribute('data-kind')).toBe('unread');
    act(() => root.render(
      <Frame>
        <NavRow href="/x" label="결재" Icon={Home} isActive={false} badgeCount={0} />
      </Frame>,
    ));
    expect(host.textContent).not.toContain('9+');
    expect(host.textContent).not.toContain('프로젝트');
    expect(host.querySelector('kbd')).toBeNull();
  });

  it('NavRow: 줄은 ds ListRow(compact) · 내 손 필요 배지는 이름이 실린다', () => {
    act(() => root.render(
      <Frame>
        <NavRow href="/inbox" label="결재" Icon={Home} isActive={false} badgeCount={3} badgeLabel="사람 손이 필요한 일" />
      </Frame>,
    ));
    const row = host.querySelector('[data-slot="ds-list-row"]');
    expect(row?.getAttribute('data-density')).toBe('compact');
    expect(row?.tagName).toBe('A');
    const badge = host.querySelector('[data-slot="ds-count-badge"]');
    expect(badge?.getAttribute('data-kind')).toBe('needs-hand');
    expect(badge?.textContent).toContain('사람 손이 필요한 일');
  });

  it('NavRow: 지금 화면 줄은 aria-current=page, navId는 data-nav-id로 달린다', () => {
    act(() => root.render(
      <Frame>
        <NavRow href="/all" label="전체" Icon={Home} isActive navId="all-screens" />
      </Frame>,
    ));
    expect(host.querySelector('a')?.getAttribute('data-nav-id')).toBe('all-screens');
    expect(host.querySelector('a')?.getAttribute('aria-current')).toBe('page');
    // 지금 화면 줄은 ds 선택 면(bg-ds-surface-high)을 입고, 아닌 줄은 안 입는다(호버 면은 hover: 접두라 따로).
    expect(host.querySelector('a')?.className.split(/\s+/)).toContain('bg-ds-surface-high');
    act(() => root.render(
      <Frame>
        <NavRow href="/all" label="전체" Icon={Home} isActive={false} />
      </Frame>,
    ));
    expect(host.querySelector('a')?.className.split(/\s+/)).not.toContain('bg-ds-surface-high');
    expect(host.querySelector('a')?.getAttribute('aria-current')).toBeNull();
  });

  it('NavGroupHeader: 접힘 상태를 aria-expanded로, 누르면 onToggle · 이름은 그룹명', () => {
    const onToggle = vi.fn();
    act(() => root.render(
      <Frame>
        <NavGroupHeader label="조직" collapsed onToggle={onToggle} />
      </Frame>,
    ));
    const btn = host.querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent?.trim()).toBe('조직');
    act(() => btn.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
