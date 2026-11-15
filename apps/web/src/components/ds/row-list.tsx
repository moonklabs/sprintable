'use client';

import { Fragment, useCallback, useId, useLayoutEffect, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { LAYER } from './layers';
import { type IconName } from './icon';
import { IconButton } from './icon-button';
import { ListRow } from './list-row';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './menu';
import { SectionHeader, type SectionHeaderProps } from './section-header';

/** 행 하나가 할 수 있는 일 — «⋯» 메뉴와 우클릭 메뉴가 **같은 배열**을 그려서 두 길이 어긋나지 않는다(4913 · PO 11-12 «데스크톱은 우클릭이 자유롭다»). */
export interface RowAction {
  key: string;
  label: string;
  icon?: IconName;
  /** `danger` = 지우기 같은 위험 항목. 확인 한 단계는 호출부가 붙인다. */
  variant?: 'default' | 'danger';
  disabled?: boolean;
  onSelect: () => void;
  /** 이 항목 앞에 구분선. */
  separatorBefore?: boolean;
}

function ActionItems({ actions }: { actions: RowAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Fragment key={a.key}>
          {a.separatorBefore ? <MenuSeparator /> : null}
          <MenuItem icon={a.icon} variant={a.variant} disabled={a.disabled} onClick={a.onSelect}>
            {a.label}
          </MenuItem>
        </Fragment>
      ))}
    </>
  );
}

const ROW_MAIN = '[data-row-main]';

export interface RowListProps {
  /** 구획 머리(제목 + 건수 + 오른쪽 보조). 없으면 머리 없이 행만. */
  header?: Pick<SectionHeaderProps, 'title' | 'count' | 'trailing' | 'level'> & {
    /** 구획 머리 바로 아래 한 줄 설명 — 목록(role=list) «밖»의 작은 글(구획이 무엇을 담는지). */
    description?: ReactNode;
  };
  'data-testid'?: string;
  /** 목록의 접근성 이름 — 필수(한 화면에 목록이 여럿이다). */
  'aria-label': string;
  className?: string;
  children: ReactNode;
}

/**
 * 4913(UI-R5) RowList — 구획 머리 + 행 목록이 **한 패널(`Card`)** 안에 선다. 행은 `RowListItem`.
 * 키보드: 행에 초점이 있으면 ↑↓ 다음/이전 행 · Home/End 처음/끝 행 · Enter 펼침/접힘 · Esc 닫기. 탭 정지는 행 하나(초점 있던 행)뿐이다 — 행이 백 개여도 Tab 백 번이 아니다.
 */
export function RowList({ header, 'aria-label': ariaLabel, className, children, 'data-testid': testId }: RowListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rovingRef = useRef<HTMLElement | null>(null);

  const rows = useCallback(() => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW_MAIN) ?? []), []);
  const syncTabStops = useCallback(() => {
    const all = rows();
    const current = rovingRef.current && all.includes(rovingRef.current) ? rovingRef.current : all[0];
    for (const el of all) el.tabIndex = el === current ? 0 : -1;
  }, [rows]);
  // 행이 늘고 줄어도 탭 정지가 하나로 유지된다(React가 tabIndex를 쥐지 않으니 다시 그려도 덮이지 않는다).
  useLayoutEffect(() => { syncTabStops(); });

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).matches(ROW_MAIN)) { rovingRef.current = e.target as HTMLElement; syncTabStops(); }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(ROW_MAIN)) return;
    const all = rows();
    const i = all.indexOf(target);
    const next = e.key === 'ArrowDown' ? all[i + 1] : e.key === 'ArrowUp' ? all[i - 1] : e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : undefined;
    if (next) { e.preventDefault(); next.focus(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) e.preventDefault(); // 끝에서 스크롤 칸이 같이 움직이지 않게
  };

  return (
    <Card data-slot="ds-row-list" data-testid={testId} className={cn('overflow-hidden', className)}>
      {header ? <SectionHeader title={header.title} count={header.count} trailing={header.trailing} level={header.level ?? 3} /> : null}
      {header?.description ? <p className="m-0 border-b border-ds-line px-4 py-2 text-ds-small text-ds-ink-3">{header.description}</p> : null}
      <div
        ref={listRef}
        role="list"
        aria-label={ariaLabel}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className="[&>[role=listitem]:last-child:not([data-open])_[data-slot=ds-list-row]]:border-b-0 [&>[role=listitem]:last-child_[data-slot=ds-row-detail]]:border-b-0 [&>[role=listitem]:last-child_[data-slot=ds-row-footnote]]:border-b-0"
      >
        {children}
      </div>
    </Card>
  );
}

/** `actions`를 주면 «⋯» 단추의 접근성 이름(`actionsLabel`)도 필수다 — 타입이 묶는다(이름 없는 단추를 못 만든다). */
type RowActionsProps =
  | {
      /** 있으면 «⋯» 메뉴와 **우클릭 메뉴**가 같은 항목으로 생긴다. 없으면 우클릭은 브라우저 기본 그대로다. */
      actions: RowAction[];
      actionsLabel: string;
      /**
       * story 4912 (B2): `'context-only'` = the same items open by **right-click only** — no «⋯» drawn. For a row whose one action is already a visible button of its own (the API key screen's «키 관리»): the same thing is not put in two places.
       * Default `'visible'` (the «⋯» menu AND the right-click menu).
       */
      actionsTrigger?: 'visible' | 'context-only';
    }
  | { actions?: undefined; actionsLabel?: never; actionsTrigger?: never };

export type RowListItemProps = RowActionsProps & Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> & {
  /** 시험 손잡이는 행 «전체»(`role=listitem` — 펼침 칸까지 담은 래퍼)에 붙는다. */
  'data-testid'?: string;
  leading?: ReactNode;
  /** `ListRow.leadingClassName` — 앞 자리 칸의 고정 폭 등. */
  leadingClassName?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 오른쪽 상태(Chip · 막대 …) — 이미 그려진 노드를 받는 슬롯. 이름이 `status`가 아닌 까닭: 원시 status 값 렌더를 잡는 `verify:no-raw-role-jsx-text`가 이름만 보고 걸린다(`TreeRow.statusMark`와 같은 이유). */
  statusMark?: ReactNode;
  /** 오른쪽 끝 자유 자리 — 호출부가 만든 단추 등(예: 이 화면 전용 펼침 단추). «⋯»가 필요하면 `actions`를 쓴다. */
  trailing?: ReactNode;
  /** 행 안 펼침(상세). `detail`이 있을 때만 의미가 있다. 한 번에 하나는 호출부가 지킨다. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  detail?: ReactNode;
  /** 주면 오른쪽에 기본 펼침 단추(▸/▾ · `aria-expanded`)가 선다. 안 주면 호출부가 `trailing`에 자기 단추를 둔다(키보드 Enter/Esc는 둘 다 된다). */
  expandLabel?: string;
  /**
   * 4912 «행 열기» — 줄 «자체»를 여는 한 가지 길(상세 쪽으로 가기 · 패널 열기). 행에 초점이 있을 때 **Enter**, 그리고 줄을 **더블클릭**하면 불린다(Enter의 포인터판).
   * 펼침 칸(`detail`)이 있는 행은 Enter가 여전히 «펼침/접힘»이다. 줄 안의 단추 · 링크 · 입력 · 체크를 더블클릭한 것은 줄을 여는 뜻이 아니라 건드리지 않는다.
   */
  onOpen?: () => void;
  /**
   * 4913 C판 — 행 «아래» 늘 서 있는 작은 글 · 오류 줄(펼침과 무관). 접혀 있어도 보여야 하는 «이 행이 왜 이 모양인가»(권한 사유 · 실패 문장)나 행 밖 단추의 결과를 담는다.
   * 펼침 칸(`detail`)과 달리 한 단 올린 면이 아니라 행과 같은 면이다. 비어 있으면(null · false) 아무것도 안 그린다.
   */
  footnote?: ReactNode;
};

/**
 * 4913(UI-R5) RowListItem — `ListRow`(높이 56) 한 줄 + 오른쪽 상태 · «⋯» + 행 안 펼침 칸(한 단 올린 면 `LAYER.rowOthers`). 펼침 칸 안의 입력칸은 한 단 내려간다(`LAYER.field`, 호출부).
 * 행 자체가 초점을 받는다(`data-row-main`): Enter = 펼침/접힘, Esc = 닫기(펼쳐 있을 때), 안쪽 단추 · 입력에서는 건드리지 않는다.
 */
export function RowListItem({
  leading, title, subtitle, statusMark, trailing, actions, actionsLabel, actionsTrigger = 'visible', expanded = false, onExpandedChange, detail, expandLabel, onOpen, footnote, className, 'data-testid': testId, onDoubleClick, ...rest
}: RowListItemProps) {
  const detailId = useId();
  const hasDetail = detail !== undefined && detail !== null && detail !== false;
  const open = hasDetail && expanded;
  const hasActions = !!actions && actions.length > 0;

  // 이름이 "close"인 까닭: Esc를 «썼다»고 표시하는 갈래는 같은 갈래에서 자기 층을 닫아야 한다(가드 esc-mark-closes-own-layer — 바깥 창이 영영 안 닫히는 갇힘 방지). 여기서 닫는 층 = 이 행의 펼침 칸.
  const closeDetail = () => onExpandedChange?.(false);
  const onRowKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' && hasDetail) { e.preventDefault(); onExpandedChange?.(!expanded); }
    else if (e.key === 'Enter' && onOpen) { e.preventDefault(); onOpen(); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); closeDetail(); }
  };
  // 더블클릭 = Enter의 포인터판. 줄 안의 단추 · 링크 · 입력 · 체크 · 메뉴 항목을 더블클릭한 것은 줄 열기가 아니다.
  const onRowDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    onDoubleClick?.(e);
    if (e.defaultPrevented || !onOpen) return;
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, label, [role="checkbox"], [role="menuitem"], [role="switch"]')) return;
    onOpen();
  };
  // 펼친 칸 안에서 Esc — 글 입력 · 선택 칸은 자기 Esc를 쓰니 건드리지 않고, 그 밖(빈 곳 · 글)에서만 접고 초점을 행으로 돌려준다.
  const onItemKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t === e.currentTarget.querySelector(ROW_MAIN)) return; // 행 자신은 onRowKeyDown이 맡는다
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    e.preventDefault();
    closeDetail();
    e.currentTarget.querySelector<HTMLElement>(ROW_MAIN)?.focus();
  };

  const row = (
    <ListRow
      {...rest}
      data-row-main=""
      tabIndex={-1}
      onKeyDown={onRowKeyDown}
      onDoubleClick={onRowDoubleClick}
      leading={leading}
      title={title}
      subtitle={subtitle}
      className={cn('focus-visible:ring-inset', className)}
      trailing={
        statusMark || trailing || hasActions || expandLabel ? (
          <>
            {statusMark}
            {trailing}
            {expandLabel && hasDetail ? (
              <IconButton
                icon={expanded ? 'expand_more' : 'chevron_right'}
                label={expandLabel}
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() => onExpandedChange?.(!expanded)}
              />
            ) : null}
            {hasActions && actionsTrigger === 'visible' ? (
              <Menu>
                <MenuTrigger render={<IconButton icon="more_horiz" label={actionsLabel} data-slot="ds-row-actions-trigger" />} />
                <MenuContent align="end">
                  <ActionItems actions={actions!} />
                </MenuContent>
              </Menu>
            ) : null}
          </>
        ) : undefined
      }
    />
  );

  return (
    <div role="listitem" data-slot="ds-row-list-item" data-testid={testId} data-open={open || undefined} onKeyDown={onItemKeyDown}>
      {hasActions ? (
        <ContextMenuPrimitive.Root>
          <ContextMenuPrimitive.Trigger data-slot="ds-row-context-trigger">{row}</ContextMenuPrimitive.Trigger>
          <MenuContent>
            <ActionItems actions={actions!} />
          </MenuContent>
        </ContextMenuPrimitive.Root>
      ) : (
        row
      )}
      {footnote ? <div data-slot="ds-row-footnote" className="space-y-1 border-b border-ds-line px-4 py-2 text-ds-small text-ds-ink-3">{footnote}</div> : null}
      {open ? (
        <div id={detailId} data-slot="ds-row-detail" className={cn('border-b border-ds-line px-4 py-3', LAYER.rowOthers)}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}
