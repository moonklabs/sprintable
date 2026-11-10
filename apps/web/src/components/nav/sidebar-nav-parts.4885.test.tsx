import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Home } from 'lucide-react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const { SidebarProvider, Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu } = await import('@/components/ui/sidebar');
const { NavGroupHeader, NavRow } = await import('./sidebar-nav-parts');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{children}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
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
    expect(src).toContain('<SidebarMenuButton');
    expect(src).toContain('<SidebarGroupLabel');
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
    act(() => root.render(
      <Frame>
        <NavRow href="/x" label="결재" Icon={Home} isActive={false} badgeCount={0} />
      </Frame>,
    ));
    expect(host.textContent).not.toContain('9+');
    expect(host.textContent).not.toContain('프로젝트');
    expect(host.querySelector('kbd')).toBeNull();
  });

  it('NavRow: 지금 화면 줄은 data-active, navId는 data-nav-id로 달린다', () => {
    act(() => root.render(
      <Frame>
        <NavRow href="/all" label="전체" Icon={Home} isActive navId="all-screens" />
      </Frame>,
    ));
    expect(host.querySelector('a')?.getAttribute('data-nav-id')).toBe('all-screens');
    expect(host.querySelector('[data-active="true"]')).not.toBeNull();
  });

  it('NavGroupHeader: 접힘 상태를 aria-expanded로, 누르면 onToggle', () => {
    const onToggle = vi.fn();
    act(() => root.render(
      <Frame>
        <NavGroupHeader label="조직" collapsed ariaLabel="조직 펼치기" onToggle={onToggle} />
      </Frame>,
    ));
    const btn = host.querySelector('button[aria-label="조직 펼치기"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    act(() => btn.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
