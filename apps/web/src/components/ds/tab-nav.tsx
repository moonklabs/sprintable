'use client';

import { Fragment, isValidElement, useCallback, useEffect, useRef, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';
import { TAB_ACTIVE, TAB_BASE, TAB_RULE, TAB_STRIP } from './tab-style';

export type TabNavProps = Omit<ComponentProps<'nav'>, 'aria-label' | 'aria-labelledby'> & {
  /** 탭줄의 접근성 이름 — 필수(화면의 `nav` 랜드마크가 여럿이라 이름이 없으면 구별이 안 된다). */
  'aria-label': string;
};

/**
 * UI-3(a9d56577) TabNav — 다른 화면(주소)으로 가는 탭줄. «팀» 탭줄 · 일감 탭줄처럼 탭 하나하나가 진짜 링크다.
 * `role=tablist` 대신 `nav` 랜드마크 + 켜진 링크의 `aria-current="page"` — 링크에 `role=tab`을 얹으면 탭 패널이 없는 줄이 «탭 패널을 가진 척»하게 된다(패널이 있는 탭은 `Tabs`).
 */
export function TabNav({ className, children, ...props }: TabNavProps) {
  return (
    <div className={TAB_RULE} data-slot="ds-tab-nav-rule">
      <nav data-slot="ds-tab-nav" className={cn(TAB_STRIP, className)} {...props}>
        {children}
      </nav>
    </div>
  );
}

type TabNavLinkBase = Omit<ComponentProps<'a'>, 'children'> & {
  /** 지금 여기인 탭 — `aria-current="page"` + 밑줄 · 굵기. */
  active?: boolean;
};

/** `asChild`면 자식은 링크 요소 하나(예: next/link — Fragment · 글 · 여럿 불가), 아니면 보통 `a`의 내용. */
export type TabNavLinkProps = TabNavLinkBase & ({ asChild: true; children: ReactElement } | { asChild?: false; children?: ReactNode });

/** 탭줄의 한 칸. 켜진 칸은 줄이 가로 스크롤이어도 화면 안으로 가져온다(이미 보이면 안 움직인다 · 페이지 세로 스크롤은 건드리지 않는다 — story #4277). */
export function TabNavLink({ active = false, asChild = false, className, children, ref: externalRef, ...props }: TabNavLinkProps) {
  const innerRef = useRef<HTMLAnchorElement | null>(null);
  // 바깥에서 준 ref와 안쪽 ref(scrollIntoView용)를 함께 건다 — 바깥 ref가 안쪽을 덮어쓰면 켜진 탭이 안 보이는 쪽으로 가도 안 따라온다.
  const setRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      innerRef.current = node;
      if (typeof externalRef === 'function') externalRef(node);
      else if (externalRef) (externalRef as { current: HTMLAnchorElement | null }).current = node;
    },
    [externalRef],
  );
  useEffect(() => {
    if (active) innerRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  // Fragment · 글 · 여럿은 Slot이 props를 못 입혀 모양 · 접근성이 샌다 — 그리지 않는다(타입도 요소 하나만 받는다).
  if (asChild && (!isValidElement(children) || children.type === Fragment)) return null;
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      ref={setRef}
      data-slot="ds-tab-nav-link"
      aria-current={active ? 'page' : undefined}
      className={cn(TAB_BASE, active && TAB_ACTIVE, className)}
      {...props}
    >
      {children}
    </Comp>
  );
}
