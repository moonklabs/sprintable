'use client';

// story #4885 (UI-2 AC4) — 길잡이(목록 칸)의 «줄»과 «묶음 머리»를 만드는 자리는 여기 하나다.
// app-sidebar.tsx는 순회만 하고 줄 모양은 모른다. 줄은 유나 UI-3 ListRow(density="compact" · 폰 44),
// 묶음 머리는 SectionHeader(줄 전체가 접기 단추)로 짓는다 — 길잡이 전용 줄 구현을 따로 두지 않는다.
import type { ComponentType, ReactNode, Ref } from 'react';
import Link from 'next/link';
import { SidebarMenuItem } from '@/components/ui/sidebar';
import { CountBadge } from '@/components/ds/count-badge';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';

export function KbdHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="hidden rounded-ds-tag border border-ds-line bg-ds-surface-sunk px-1.5 py-0 font-mono text-ds-mono-md font-medium text-ds-ink-3 sm:inline-flex">
      {children}
    </kbd>
  );
}

// story #9c5e82dc(IA·S3, 유나 § 確定 2026-09-08) — 「이 항목은 프로젝트 것」이라는 «성질»
// 표식. 칩/배지 모양(테두리·배경) 금지 — 칩은 "누를 수 있는 것"으로 읽히는데 이건 행위가
// 아니라 성질이다. 라틴 약어("PJ")·아이콘 단독+sr-only 둘 다 기각(유나 § 그대로).
// 순서는 라벨→표식→kbd. ⛔️무표식 = 조직 범위가 아니다(유나 § 명시).
export function ScopeMark({ children }: { children: ReactNode }) {
  return <span className="text-ds-small font-medium text-ds-ink-3">{children}</span>;
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
  /** 0 이하면 안 그림. 내 손이 필요한 수(결재 대기)는 색 + 화면에 안 보이는 이름으로 말한다. */
  badgeCount?: number;
  badgeCap?: number;
  badgeLabel?: string;
  /** 줄 링크에 더 붙일 data 속성(예: data-nav-id). */
  navId?: string;
}

/** 길잡이 한 줄. 줄 모양은 ds ListRow(compact)가 안다. */
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
  badgeLabel,
  navId,
}: NavRowProps) {
  return (
    <SidebarMenuItem>
      <ListRow asChild density="compact" selected={isActive} className="gap-2 px-3">
        <Link
          href={href}
          ref={activeRef}
          aria-current={isActive ? 'page' : undefined}
          {...(navId ? { 'data-nav-id': navId } : {})}
        >
          <Icon className="size-4 shrink-0 text-ds-ink-3" />
          <span data-nav-label className="min-w-0 flex-1 truncate text-ds-body font-semibold text-ds-ink">{label}</span>
          {scopeMark || kbd ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {scopeMark ? <ScopeMark>{scopeMark}</ScopeMark> : null}
              {kbd ? <KbdHint>{kbd}</KbdHint> : null}
            </span>
          ) : null}
          {badgeCount > 0 ? (
            badgeLabel
              ? <CountBadge kind="needs-hand" label={badgeLabel} count={badgeCount} max={badgeCap} />
              : <CountBadge count={badgeCount} max={badgeCap} />
          ) : null}
        </Link>
      </ListRow>
    </SidebarMenuItem>
  );
}

export interface NavGroupHeaderProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** 길잡이 묶음 머리(줄 어디를 눌러도 접고 펴는 줄). 접근 가능한 이름 = 그룹명, 상태 = aria-expanded. */
export function NavGroupHeader({ label, collapsed, onToggle }: NavGroupHeaderProps) {
  return <SectionHeader title={label} collapsed={collapsed} onToggle={onToggle} level={3} />;
}
