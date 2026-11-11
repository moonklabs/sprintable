'use client';

import type { ReactNode } from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

/** UI-3(a9d56577) Menu — 단추 하나에서 펼쳐지는 목록. 열고 닫기 · 화살표 이동 · 바깥 눌러 닫기 · Esc · 초점 복원은 Base UI 몫이다(현행 `ui/dropdown-menu`와 같은 바탕). */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;

export type MenuContentProps = Omit<MenuPrimitive.Popup.Props, 'className'> &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & { className?: string };

/**
 * 목록 상자 — 모서리 8 · 면 `surface-raised` · 경계 `line-control` · 최소 폭 160. 길면 안에서 스크롤(`max-h` = 사용 가능한 높이).
 * ⚠️ 이 상자 «안»에 스크롤 칸을 더 넣으면 `tabIndex={-1}`을 준다 — 크롬이 넘치는 스크롤 칸을 키보드 초점 대상으로 만들어 역할 · 이름 없는 칸에 멈춘다(story #4308).
 */
export function MenuContent({ align = 'start', alignOffset = 0, side = 'bottom', sideOffset = 4, className, ...props }: MenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="isolate z-50 outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          data-slot="ds-menu-content"
          className={cn(
            'z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-ds-panel border border-ds-line-control bg-ds-surface-raised p-1 text-ds-body text-ds-ink shadow-ds-overlay outline-none',
            'duration-(--ds-duration-fast) motion-reduce:duration-(--ds-duration-instant) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export type MenuItemProps = Omit<MenuPrimitive.Item.Props, 'className' | 'children'> & {
  className?: string;
  children: ReactNode;
  /** 글 앞 아이콘(장식 — 뜻은 글이 싣는다). */
  icon?: IconName;
  /** 오른쪽 단축키 표기(예: `<Kbd>⌘K</Kbd>`). */
  shortcut?: ReactNode;
  /** `danger` = 지우기 같은 위험 항목(글 색 `failed`). 확인 한 단계는 호출부가 `ConfirmDialog`로 붙인다. */
  variant?: 'default' | 'danger';
};

/** 항목 한 칸 — 높이 32(폰 44). 키보드로 닿으면 안쪽 링 2px `action`(바탕 색 변화만으로 «지금 여기»를 말하지 않는다). 비활성 = `ink-3`. */
export function MenuItem({ className, children, icon, shortcut, variant = 'default', ...props }: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="ds-menu-item"
      data-variant={variant}
      className={cn(
        'relative flex min-h-ds-compact cursor-default select-none items-center gap-2 rounded-ds-control px-2 text-ds-body outline-none touch:min-h-ds-touch',
        'data-highlighted:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action',
        'data-disabled:pointer-events-none data-disabled:text-ds-ink-3',
        variant === 'danger' ? 'text-ds-failed' : 'text-ds-ink',
        className,
      )}
      {...props}
    >
      {icon ? <Icon name={icon} className="shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-4 shrink-0 text-ds-ink-3">{shortcut}</span> : null}
    </MenuPrimitive.Item>
  );
}

export type MenuLabelProps = Omit<MenuPrimitive.GroupLabel.Props, 'className'> & { className?: string };

/** 묶음 이름 — 작은 보조 글. `MenuGroup` 안에서 쓴다(스크린리더가 묶음 이름을 읽는다). */
export function MenuLabel({ className, ...props }: MenuLabelProps) {
  return <MenuPrimitive.GroupLabel data-slot="ds-menu-label" className={cn('px-2 py-1 text-ds-small font-semibold text-ds-ink-3', className)} {...props} />;
}

export type MenuSeparatorProps = Omit<MenuPrimitive.Separator.Props, 'className'> & { className?: string };

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return <MenuPrimitive.Separator data-slot="ds-menu-separator" className={cn('-mx-1 my-1 h-px bg-ds-line', className)} {...props} />;
}
