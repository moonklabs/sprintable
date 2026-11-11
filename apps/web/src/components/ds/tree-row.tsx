'use client';

import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { HOVER_REVEAL, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';
import { Button } from './button';
import { Icon, type IconName } from './icon';

// 깊이당 들여쓰기 16px. 클래스를 통째로 적어 두어야 빌드가 알아본다 — 8단을 넘으면 맨 끝에서 멈춘다.
const PAD = ['pl-2', 'pl-6', 'pl-10', 'pl-14', 'pl-18', 'pl-22', 'pl-26', 'pl-30', 'pl-34'] as const;
const HANDLE_GAP = ['w-0', 'w-4', 'w-8', 'w-12', 'w-16', 'w-20', 'w-24', 'w-28', 'w-32'] as const;

function level(depth: number): number {
  return Math.min(Math.max(0, Math.trunc(depth)), PAD.length - 1);
}

/** 깊이의 들여쓰기 px — 제목 글이 시작하는 자리를 계산해야 하는 호출부(삽입선 등)가 쓴다. 줄과 같은 표를 쓰니 어긋나지 않는다. */
export function treeIndentPx(depth: number): number {
  return level(depth) * 16;
}

export type TreeRowProps = {
  /** 깊이(0부터) — 깊이당 16px 들여쓴다. */
  depth: number;
  /** 줄의 이름 글. 한 줄 말줄임. */
  title: ReactNode;
  /** 글 앞 아이콘(문서 · 폴더 · 열린 폴더) — 장식, 뜻은 제목 글이 싣는다. */
  icon?: IconName;
  /** 사용자가 고른 이모지 — 있으면 아이콘 대신 그린다(장식). */
  emoji?: string;
  /** 제목 앞 상태 표시(점 등) — 호출부가 읽히는 이름을 함께 준다. 이름이 `status`가 아닌 까닭: 원시 status 값 렌더를 잡는 `verify:no-raw-role-jsx-text`가 이름만 보고 걸린다(여기는 이미 그려진 노드를 받는 슬롯). */
  statusMark?: ReactNode;
  /** 지금 열어 둔 줄 — 줄 단추에 `aria-current="page"` + 옅은 `action` 면. */
  selected?: boolean;
  /** 펼침 상태 — 있으면 폴더 줄이다: 단추에 `aria-expanded`, 앞에 접힘/펼침 화살표 글리프. 없으면 잎 줄이고 같은 크기의 빈 자리를 둔다(제목이 줄을 맞춘다). */
  expanded?: boolean;
  /** 끌어 놓을 자리 — 줄 단추에 `data-drop-zone`(before · into · after)으로 남긴다(지금 문서 트리와 같은 세 값). «into»일 때만 옅은 면 + 안쪽 테두리(칠만으론 약해 둘째 축)를 입힌다. before · after의 삽입선은 호출부가 그린다. */
  dropZone?: 'before' | 'into' | 'after';
  /** 마우스 전용 끌기 손잡이 — 줄 왼쪽 깊이 자리에 얹힌다. 호출부의 dnd 속성 · 센서가 그대로 달린 노드를 준다(이 부품은 끌기 동작을 모른다). 호버 때만 보이고 터치에는 없다. */
  dragHandle?: ReactNode;
  /** 오른쪽 행동(보통 «⋮» 메뉴 단추) — 줄 오른쪽 끝에 얹힌다. 호버가 없는 기기에서는 늘 보이고, 마우스에서만 호버 · 초점 때 드러난다. */
  trailing?: ReactNode;
  /** 줄 단추의 속성 — onClick · onContextMenu · onMouseEnter/Leave(미리보기 카드 기준점) · `data-doc-id` 등. */
  controlProps?: Omit<ComponentProps<'button'>, 'children' | 'className' | 'type' | 'disabled' | 'onClick'> & {
    /** ds Button과 같은 모양 — 이벤트는 `MouseEvent<HTMLElement>`로 받는다(호출부 핸들러의 인자 형을 맞출 것). */
    onClick?: (event: MouseEvent<HTMLElement>) => void;
  };
  className?: string;
} & Omit<ComponentProps<'div'>, 'title' | 'children' | 'className'>;

/**
 * UI-3(a9d56577) TreeRow — doc v0.3 M17 «TreeView»의 한 줄. 지금 문서 트리 줄의 구조 그대로다: 줄 전체가 하나의 단추(들여쓰기 + 화살표 글리프 + 아이콘/이모지 + 상태 + 제목) 위에,
 * 오른쪽 «⋮»(trailing)와 왼쪽 끌기 손잡이(dragHandle)가 따로 얹힌다. 단추는 줄 높이 36(폰 44) 전체를 누른다.
 * 접힌 자식을 그리고 안 그리는 일 · 키 · 끌기 센서 · 미리보기 카드 · 메뉴는 호출부(지금의 문서 트리)가 그대로 맡는다 — 이 부품은 «한 줄의 모양»이다.
 * 트리 역할(`role=tree`)과 화살표 키는 얹지 않는다: 지금 트리에는 없는 것이고, 얹으면 키 약속까지 따라와야 한다(새 기능).
 */
export function TreeRow({ depth, title, icon, emoji, statusMark, selected = false, expanded, dropZone, dragHandle, trailing, controlProps, className, ...rest }: TreeRowProps) {
  const lv = level(depth);
  const isFolder = expanded !== undefined;
  return (
    <div {...rest} data-slot="ds-tree-row" data-depth={depth} className={cn('group relative', className)}>
      {dragHandle ? (
        <div data-slot="ds-tree-handle" className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:hidden [@media(hover:none)]:hidden">
          <span aria-hidden="true" className={cn('shrink-0', HANDLE_GAP[lv])} />
          <span className="pointer-events-auto">{dragHandle}</span>
        </div>
      ) : null}
      <Button
        type="button"
        variant="quiet"
        {...controlProps}
        aria-current={selected ? 'page' : undefined}
        aria-expanded={isFolder ? expanded : undefined}
        data-drop-zone={dropZone}
        // ds Button(조용 변형)이 폰 누름 영역 44(touch:min-h-11)와 초점 링을 이미 쥔다 — 줄 모양만 덮는다(오른쪽 여백: 마우스 40 = right-2 + 24 «⋮», 폰 56 = right-2 + 44 누름 영역 + 숨): 높이는 내용을 따르되 36 이상, 가득 폭, 왼쪽 정렬, 글 굵기는 제목에만.
        className={cn(
          'h-auto min-h-9 w-full justify-start gap-2 whitespace-normal py-1 pr-10 touch:pr-14 text-left text-ds-body font-normal focus-visible:ring-inset focus-visible:ring-offset-0',
          PAD[lv],
          selected ? 'border-transparent bg-ds-action-soft text-ds-action-text hover:bg-ds-action-soft hover:text-ds-action-text' : 'text-ds-ink',
          dropZone === 'into' && 'bg-ds-action-soft ring-1 ring-inset ring-ds-action',
        )}
      >
        {isFolder ? (
          <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0 text-ds-ink-3" />
        ) : (
          // 잎 줄: 화살표 자리를 같은 크기로 비워 같은 깊이의 제목이 줄을 맞춘다(폰에서도 같은 폭).
          <span aria-hidden="true" data-slot="ds-tree-arrow-gap" className="size-3.5 shrink-0" />
        )}
        {emoji ? (
          <span aria-hidden="true" data-slot="ds-tree-emoji" className="shrink-0 text-ds-body">{emoji}</span>
        ) : icon ? (
          <Icon name={icon} className="shrink-0 text-ds-ink-3" />
        ) : null}
        {statusMark ? <span className="shrink-0">{statusMark}</span> : null}
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
      </Button>
      {trailing ? (
        <div data-slot="ds-tree-trailing" className={cn('absolute top-1/2 right-2 -translate-y-1/2 transition-opacity duration-100 motion-reduce:transition-none', HOVER_REVEAL_HIT, HOVER_REVEAL)}>
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
