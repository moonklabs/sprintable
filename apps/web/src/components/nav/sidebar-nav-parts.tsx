'use client';

// story #4885 (UI-2 AC4) — 길잡이(목록 칸)의 «줄»과 «묶음 머리»를 만드는 자리는 여기 하나다.
// app-sidebar.tsx는 순회만 하고 줄 모양은 모른다. 유나 5526(ListRow density=compact · SectionHeader)이
// 들어오면 이 파일 안쪽만 바꾼다(줄 구현이 둘이 되지 않게 · 손으로 토큰 클래스를 입히지 않는다).
import type { ComponentType, ReactNode, Ref } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SidebarGroupLabel,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export function KbdHint({ children }: { children: ReactNode }) {
  return (
    // 3826-pre — text-sidebar-foreground/60(알파 합성)이 v3 ink 재조정 후 실 브라우저
    // 대비 미달(#767573/#fbfaf9 = 4.43:1)로 바뀌었다. solid text-muted-foreground(=
    // --proof-ink-3, AA 조정 済)로 교체 — active 상태는 알파 대신 solid 전체 강조.
    <kbd className="hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-micro font-medium text-muted-foreground group-data-[active=true]/menu-button:text-sidebar-foreground sm:inline-flex">
      {children}
    </kbd>
  );
}

// story #9c5e82dc(IA·S3, 유나 § 確定 2026-09-08) — 「이 항목은 프로젝트 것」이라는 «성질»
// 표식. 칩/배지 모양(테두리·배경) 금지 — 칩은 "누를 수 있는 것"으로 읽히는데 이건 행위가
// 아니라 성질이다. 라틴 약어("PJ")·아이콘 단독+sr-only 둘 다 기각(유나 § 그대로).
// 순서는 라벨→표식→kbd. ⛔️무표식 = 조직 범위가 아니다(유나 § 명시).
export function ScopeMark({ children }: { children: ReactNode }) {
  return (
    // 3826-pre — KbdHint와 동일 사유(알파 합성 → solid muted 교체).
    <span className="text-micro font-medium text-muted-foreground group-data-[active=true]/menu-button:text-sidebar-foreground">
      {children}
    </span>
  );
}

export interface NavRowProps {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  isActive: boolean;
  /** 지금 화면 줄에만 달아 스크롤로 보이게 하는 ref. */
  activeRef?: Ref<HTMLAnchorElement>;
  /** 프로젝트 범위 표식 글자(없으면 안 그림). */
  scopeMark?: string | null;
  /** 받는 키 처리가 있는 단축키만 넘긴다(호출 쪽이 isRealShortcut으로 거른다). */
  kbd?: string | null;
  /** 0 이하면 안 그림. */
  badgeCount?: number;
  badgeCap?: number;
  /** 줄 링크에 더 붙일 data 속성(예: data-nav-id). */
  navId?: string;
}

/** 길잡이 한 줄. 줄 모양은 이 컴포넌트만 안다. */
export function NavRow({
  href,
  label,
  Icon,
  isActive,
  activeRef,
  scopeMark,
  kbd,
  badgeCount = 0,
  badgeCap = 99,
  navId,
}: NavRowProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link href={href} ref={activeRef} {...(navId ? { 'data-nav-id': navId } : {})} />}
        isActive={isActive}
        tooltip={label}
      >
        <Icon />
        <span data-nav-label>{label}</span>
        {scopeMark || kbd ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {scopeMark ? <ScopeMark>{scopeMark}</ScopeMark> : null}
            {kbd ? <KbdHint>{kbd}</KbdHint> : null}
          </span>
        ) : null}
        {badgeCount > 0 ? (
          <SidebarMenuBadge>{badgeCount > badgeCap ? `${badgeCap}+` : badgeCount}</SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export interface NavGroupHeaderProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** 카디르 QA(a11y, §22-18 가드) — 그룹명 + 접힘 상태를 담은 접근 가능한 이름. */
  ariaLabel: string;
}

/** 길잡이 묶음 머리(누르면 접고 펴는 줄). */
export function NavGroupHeader({ label, collapsed, onToggle, ariaLabel }: NavGroupHeaderProps) {
  return (
    <SidebarGroupLabel
      render={
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={ariaLabel}
        />
      }
      className="w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <span>{label}</span>
      <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-150', collapsed && '-rotate-90')} />
    </SidebarGroupLabel>
  );
}
