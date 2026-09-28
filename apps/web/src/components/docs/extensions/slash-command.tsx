'use client';

import { Extension } from '@tiptap/core';
import Suggestion, { exitSuggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { createRoot, type Root } from 'react-dom/client';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import type { Editor, Range } from '@tiptap/core';
import type { FC } from 'react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Code,
  Quote,
  Lightbulb,
  Table,
  ImageIcon,
  Minus,
  FileText,
  GitBranch,
  ChevronRight,
  Paperclip,
  Globe,
  Sigma,
  Columns2,
} from 'lucide-react';

import { startAttachmentUpload } from './image-upload';

/** 파일 피커 → Storage 업로드 플로우(gutter +·slash·DnD·paste 공용 진입). */
export function pickAndUpload(editor: Editor, accept?: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void startAttachmentUpload(editor, file);
  };
  input.click();
}

export interface SlashMenuItem {
  /** 로케일 무관 고정 키(React key · 테스트). */
  id: string;
  /** story #4377 — 화면에 보이는 제목(로케일 · `strings.titles`). 예전엔 영어 리터럴이라 한국어 화면에 «Heading 1»이 떴다. */
  title: string;
  /** 거르기 별칭 — 첫째는 예전 영어 제목(영어로 치던 사람도 걸리게 · «/heading» · «/page»). 그 뒤는 찾기 전용 다른 표기(화면엔 안 나옴 · 예: 칼럼의 «컬럼»). */
  aliases: string[];
  description: string;
  icon: FC<{ className?: string }>;
  command: (editor: Editor, range: Range) => void;
}

export interface SlashMenuCategory {
  label: string;
  items: SlashMenuItem[];
}

// story ab2fd813(#2028) — 이 파일의 슬래시 팝업은 `createRoot(popup)`로 React 트리 밖(body
// append)에 렌더돼 `useTranslations`를 여기서 직접 못 쓴다. 그래서 로케일 문자열은 소비처
// (doc-editor.tsx, 이미 useTranslations 보유)가 빌드해 이 팩토리에 주입하는 형태로 뒤집는다.
export interface SlashMenuStrings {
  categories: {
    text: string;
    list: string;
    block: string;
    media: string;
    advanced: string;
  };
  /** story #4377 — 항목 제목(로케일). 키는 `items`와 같다. */
  titles: SlashMenuStrings['items'];
  items: {
    heading1: string;
    heading2: string;
    heading3: string;
    bulletList: string;
    orderedList: string;
    checklist: string;
    codeBlock: string;
    blockquote: string;
    callout: string;
    table: string;
    image: string;
    file: string;
    embed: string;
    mermaidDiagram: string;
    columns: string;
    mathBlock: string;
    mathInline: string;
    toggle: string;
    pageEmbed: string;
    horizontalRule: string;
  };
  embedPrompt: string;
  /** 삽입되는 문서 콘텐츠 기본값(mermaid 템플릿의 시작/끝 라벨) — 유일한 실 호출부
   * (doc-editor.tsx)가 항상 채워 넘긴다(story #3930, 미사용 옵셔널 한글 폴백 제거). */
  mermaidDefault: { start: string; end: string };
  /** 삽입되는 문서 콘텐츠 기본값(새 토글 블록 제목) — 유일한 실 호출부가 항상 채워 넘긴다. */
  toggleDefaultTitle: string;
  /** story #4383 — 칼럼 항목의 찾기 전용 다른 표기(ko «컬럼» · en 빈 값). 화면엔 안 나온다. */
  columnsSearchAlias: string;
  /** story #4380 — 목록상자 이름(화면 읽기가 «블록 추가 목록»으로 읽는다). */
  listLabel: string;
}

/** id/icon/command/aliases(영어 별칭)는 리터럴로 고정, title/label/description/embed
 * prompt/삽입 기본값은 `strings`에서 resolve한다(story #4377 — 제목도 로케일). */
/**
 * story #4377 — 슬래시 거르기: 지금 로케일 제목 · 영어 별칭 둘 다에 대소문자 무시 부분일치. 예전엔 영어 제목 하나로만 걸러
 * 한국어로 «/제목»을 치면 안 걸렸다(제목도 영어였다). 영어로 치던 사람(«/heading» · «/page»)도 그대로 걸린다.
 */
export function matchesSlashQuery(item: Pick<SlashMenuItem, 'title' | 'aliases'>, query: string): boolean {
  const q = query.toLowerCase();
  return [item.title, ...item.aliases].some((text) => text.toLowerCase().includes(q));
}

export function buildSlashMenuCategories(strings: SlashMenuStrings): SlashMenuCategory[] {
  const mermaidStart = strings.mermaidDefault.start;
  const mermaidEnd = strings.mermaidDefault.end;
  const toggleTitle = strings.toggleDefaultTitle;

  return [
    {
      label: strings.categories.text,
      items: [
        {
          id: 'heading1',
          title: strings.titles.heading1,
          aliases: ['Heading 1'],
          description: strings.items.heading1,
          icon: Heading1,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
        },
        {
          id: 'heading2',
          title: strings.titles.heading2,
          aliases: ['Heading 2'],
          description: strings.items.heading2,
          icon: Heading2,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
        },
        {
          id: 'heading3',
          title: strings.titles.heading3,
          aliases: ['Heading 3'],
          description: strings.items.heading3,
          icon: Heading3,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
        },
      ],
    },
    {
      label: strings.categories.list,
      items: [
        {
          id: 'bulletList',
          title: strings.titles.bulletList,
          aliases: ['Bullet List'],
          description: strings.items.bulletList,
          icon: List,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleBulletList().run(),
        },
        {
          id: 'orderedList',
          title: strings.titles.orderedList,
          aliases: ['Ordered List'],
          description: strings.items.orderedList,
          icon: ListOrdered,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
        },
        {
          id: 'checklist',
          title: strings.titles.checklist,
          aliases: ['Checklist'],
          description: strings.items.checklist,
          icon: ListTodo,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleTaskList().run(),
        },
      ],
    },
    {
      label: strings.categories.block,
      items: [
        {
          id: 'codeBlock',
          title: strings.titles.codeBlock,
          aliases: ['Code Block'],
          description: strings.items.codeBlock,
          icon: Code,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
        },
        {
          id: 'blockquote',
          title: strings.titles.blockquote,
          aliases: ['Blockquote'],
          description: strings.items.blockquote,
          icon: Quote,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
        },
        {
          id: 'callout',
          title: strings.titles.callout,
          aliases: ['Callout'],
          description: strings.items.callout,
          icon: Lightbulb,
          command: (editor, range) =>
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent({ type: 'callout', content: [{ type: 'paragraph' }] })
              .run(),
        },
        {
          id: 'table',
          title: strings.titles.table,
          aliases: ['Table'],
          description: strings.items.table,
          icon: Table,
          command: (editor, range) =>
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run(),
        },
      ],
    },
    {
      label: strings.categories.media,
      items: [
        {
          id: 'image',
          title: strings.titles.image,
          aliases: ['Image'],
          description: strings.items.image,
          icon: ImageIcon,
          command: (editor, range) => {
            editor.chain().focus().deleteRange(range).run();
            pickAndUpload(editor, 'image/*');
          },
        },
        {
          id: 'file',
          title: strings.titles.file,
          aliases: ['File'],
          description: strings.items.file,
          icon: Paperclip,
          command: (editor, range) => {
            editor.chain().focus().deleteRange(range).run();
            pickAndUpload(editor);
          },
        },
        {
          id: 'embed',
          title: strings.titles.embed,
          aliases: ['Embed'],
          description: strings.items.embed,
          icon: Globe,
          command: (editor, range) => {
            const url = window.prompt(strings.embedPrompt);
            editor.chain().focus().deleteRange(range).run();
            if (url?.trim()) {
              editor.commands.insertContent({ type: 'embedBlock', attrs: { url: url.trim() } });
            }
          },
        },
        {
          id: 'mermaidDiagram',
          title: strings.titles.mermaidDiagram,
          aliases: ['Mermaid Diagram'],
          description: strings.items.mermaidDiagram,
          icon: GitBranch,
          command: (editor, range) =>
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent({
                type: 'codeBlock',
                attrs: { language: 'mermaid' },
                content: [{ type: 'text', text: `flowchart TD\n    A[${mermaidStart}] --> B[${mermaidEnd}]` }],
              })
              .run(),
        },
      ],
    },
    {
      label: strings.categories.advanced,
      items: [
        {
          id: 'columns',
          title: strings.titles.columns,
          // story #4383(유나) — 화면 표기는 «칼럼» 하나지만 흔한 다른 표기(ko «컬럼»)로 찾아도 걸리게. 찾기 전용 · 화면엔 안 나옴 · 로케일 값(en은 빈 값).
          aliases: ['Columns', strings.columnsSearchAlias].filter(Boolean),
          description: strings.items.columns,
          icon: Columns2,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'columnsBlock',
              attrs: { columns: 2 },
              content: [
                { type: 'columnBlock', content: [{ type: 'paragraph' }] },
                { type: 'columnBlock', content: [{ type: 'paragraph' }] },
              ],
            }).run(),
        },
        {
          id: 'mathBlock',
          title: strings.titles.mathBlock,
          aliases: ['Math Block'],
          description: strings.items.mathBlock,
          icon: Sigma,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'mathBlock',
              content: [{ type: 'text', text: 'E = mc^2' }],
            }).run(),
        },
        {
          id: 'mathInline',
          title: strings.titles.mathInline,
          aliases: ['Math Inline'],
          description: strings.items.mathInline,
          icon: Sigma,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'mathInline',
              content: [{ type: 'text', text: 'x^2' }],
            }).run(),
        },
        {
          id: 'toggle',
          title: strings.titles.toggle,
          aliases: ['Toggle'],
          description: strings.items.toggle,
          icon: ChevronRight,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'toggleBlock',
              attrs: { open: false },
              content: [
                { type: 'toggleSummary', content: [{ type: 'text', text: toggleTitle }] },
                { type: 'toggleContent', content: [{ type: 'paragraph' }] },
              ],
            }).run(),
        },
        {
          id: 'pageEmbed',
          title: strings.titles.pageEmbed,
          aliases: ['Page Embed'],
          description: strings.items.pageEmbed,
          icon: FileText,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertPageEmbed().run(),
        },
        {
          id: 'horizontalRule',
          title: strings.titles.horizontalRule,
          aliases: ['Horizontal Rule'],
          description: strings.items.horizontalRule,
          icon: Minus,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
        },
      ],
    },
  ];
}

interface SlashMenuRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

function groupByCategory(
  items: SlashMenuItem[],
  categories: SlashMenuCategory[],
): { label: string; items: SlashMenuItem[] }[] {
  return categories
    .map((cat) => ({
      label: cat.label,
      items: cat.items.filter((item) => items.includes(item)),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * story #4380 — 화면 읽기가 켜진 항목을 안다: 메뉴 = listbox(이름 = listLabel) · 분류 = 이름 붙은 group · 항목 = option(켜진 것 aria-selected).
 * 초점은 편집기에 그대로 두고(글자를 계속 친다) 편집기 요소(tiptap이 role="textbox")에 aria-controls · aria-activedescendant를 단다 —
 * 메뉴가 닫히면(onExit — Escape로 닫아도 suggestion이 onExit를 부른다) 뗀다. 예전엔 단추 목록뿐이라 ↑↓로 옮긴 «켜짐»이 모양(bg-brand)으로만 보였다.
 * 항목은 단추가 아니라 div — 누르는 순간 편집기 초점을 뺏지 않게 mousedown 기본 동작을 막는다.
 */
const SlashMenu = forwardRef<
  SlashMenuRef,
  {
    items: SlashMenuItem[];
    categories: SlashMenuCategory[];
    query: string;
    command: (item: SlashMenuItem) => void;
    idPrefix: string;
    listLabel: string;
    editorDom: HTMLElement | null;
  }
>(function SlashMenu({ items, categories, query, command, idPrefix, listLabel, editorDom }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const safeIndex = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;
  const listId = `${idPrefix}-list`;
  const optionId = (item: SlashMenuItem) => `${idPrefix}-opt-${item.id}`;
  const activeItem = items[safeIndex];
  const activeId = activeItem ? optionId(activeItem) : null;

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[safeIndex];
        if (item) command(item);
        return true;
      }
      return false;
    },
    [items, safeIndex, command],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown]);

  // 편집기 요소가 켜진 항목을 가리킨다(항목이 없으면 뗀다) · 켜진 항목이 목록 밖이면 보이게 굴린다.
  useLayoutEffect(() => {
    if (!editorDom) return;
    if (activeId) {
      editorDom.setAttribute('aria-controls', listId);
      editorDom.setAttribute('aria-activedescendant', activeId);
      document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
    } else {
      clearSlashMenuAria(editorDom);
    }
  }, [editorDom, activeId, listId]);

  if (items.length === 0) return null;

  const grouped = query === '' ? groupByCategory(items, categories) : null;

  const renderItem = (item: SlashMenuItem, flatIndex: number) => {
    const isActive = flatIndex === safeIndex;
    const Icon = item.icon;
    return (
      <div
        key={item.id}
        id={optionId(item)}
        role="option"
        aria-selected={isActive}
        data-active={isActive}
        className={`flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
          isActive
            ? 'bg-brand/14 text-brand-text'
            : 'text-foreground hover:bg-white/6'
        }`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => command(item)}
      >
        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 ${isActive ? 'border-brand/30 bg-brand/10' : 'bg-muted/40'}`}>
          <Icon className={`size-3.5 ${isActive ? 'text-brand-text' : 'text-muted-foreground'}`} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs font-medium leading-tight">{item.title}</span>
          <span className="truncate text-[11px] text-muted-foreground">{item.description}</span>
        </span>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      id={listId}
      role="listbox"
      aria-label={listLabel}
      // 목록 안 빈 곳(여백 · 분류 이름)을 눌러도 초점은 편집기에 남긴다(초점 받을 수 없는 곳을 누르면 브라우저가 편집기 초점을 푼다).
      // 목록은 탭 순서에 넣지 않는다 — 초점은 편집기에 두고 ↑↓가 켜진 항목을 보이게 굴린다(activedescendant 규약).
      onMouseDown={(event) => event.preventDefault()}
      // story #3007(로드맵 P2·PR-E, L1) — 슬래시메뉴는 floating이라 --elev-overlay.
      className="max-h-72 w-64 overflow-y-auto rounded-xl border border-white/10 bg-card p-1 shadow-[var(--elev-overlay)]"
    >
      {grouped ? (
        grouped.map((group, groupIndex) => {
          const labelId = `${idPrefix}-group-${groupIndex}`;
          return (
            <div key={group.label} role="group" aria-labelledby={labelId}>
              <p id={labelId} role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                {group.label}
              </p>
              {group.items.map((item) => {
                const flatIndex = items.indexOf(item);
                return renderItem(item, flatIndex);
              })}
            </div>
          );
        })
      ) : (
        items.map((item, index) => renderItem(item, index))
      )}
    </div>
  );
});

function clearSlashMenuAria(editorDom: HTMLElement | null | undefined): void {
  editorDom?.removeAttribute('aria-controls');
  editorDom?.removeAttribute('aria-activedescendant');
}

/** Estimated max-height of the dropdown (matches `max-h-72` = 18rem at 16px/rem). */
const MENU_ESTIMATED_HEIGHT = 288;
/** Estimated min-width of the dropdown for initial right-edge clamping. */
const MENU_ESTIMATED_WIDTH = 256;
/** Gap between caret anchor and popup edge, in px. */
const CARET_GAP = 4;
/** Minimum distance from viewport edges, in px. */
const VIEWPORT_MARGIN = 8;

export function calculatePopupPosition(
  anchorRect: DOMRect,
  popupHeight: number,
  popupWidth: number,
  viewportWidth: number,
  viewportHeight: number,
): { top: number; left: number } {
  const spaceBelow = viewportHeight - anchorRect.bottom - VIEWPORT_MARGIN;
  const spaceAbove = anchorRect.top - VIEWPORT_MARGIN;

  let top: number;
  if (spaceBelow >= popupHeight || spaceBelow >= spaceAbove) {
    top = anchorRect.bottom + CARET_GAP;
  } else {
    top = anchorRect.top - CARET_GAP - popupHeight;
  }

  top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - popupHeight - VIEWPORT_MARGIN));

  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchorRect.left, viewportWidth - popupWidth - VIEWPORT_MARGIN),
  );

  return { top, left };
}

function applyPosition(
  popup: HTMLElement,
  clientRectFn: (() => DOMRect | null) | null | undefined,
): void {
  const rect = clientRectFn?.();
  if (!rect) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const initial = calculatePopupPosition(rect, MENU_ESTIMATED_HEIGHT, MENU_ESTIMATED_WIDTH, vw, vh);
  popup.style.top = `${initial.top}px`;
  popup.style.left = `${initial.left}px`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!popup.isConnected) return;
      const actualHeight = popup.offsetHeight || MENU_ESTIMATED_HEIGHT;
      const actualWidth = popup.offsetWidth || MENU_ESTIMATED_WIDTH;
      const refined = calculatePopupPosition(rect, actualHeight, actualWidth, vw, vh);
      popup.style.top = `${refined.top}px`;
      popup.style.left = `${refined.left}px`;
    });
  });
}

let slashMenuInstance = 0;

// story #4380(까디르 · PO 07:56Z) — 메뉴 닫기에 쓰는 이 메뉴만의 키(wiki-link · story-mention처럼). 기본 키를 두 suggestion이 나눠 쓰지 않게.
const SLASH_SUGGESTION_KEY = new PluginKey('slashCommandSuggestion');

function createSuggestionRenderer(categories: SlashMenuCategory[], listLabel: string) {
  let popup: HTMLElement | null = null;
  let root: Root | null = null;
  let menuRef: SlashMenuRef | null = null;
  // 메뉴마다 따로(한 쪽에 편집기가 둘이어도 id가 겹치지 않게).
  const idPrefix = `slash-menu-${++slashMenuInstance}`;
  let editorDom: HTMLElement | null = null;
  let offBlur: (() => void) | null = null;

  return {
    onStart(props: {
      editor: Editor;
      range: Range;
      query: string;
      items: SlashMenuItem[];
      command: (item: SlashMenuItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) {
      popup = document.createElement('div');
      popup.style.position = 'fixed';
      popup.style.zIndex = '9999';
      document.body.appendChild(popup);

      applyPosition(popup, props.clientRect);

      editorDom = props.editor.view.dom;
      // story #4380(까디르 · PO 07:56Z) — 바깥을 누르거나(제목 칸 · 빈 곳) 편집기에서 초점이 나가면 메뉴를 닫는다. 예전엔 메뉴가 떠 있는
      // 채 남아(develop부터) 편집기 aria-activedescendant가 보이지 않는 선택지를 계속 가리켰다 — 보조기기에 거짓 상태. 메뉴 안
      // 누르기는 mousedown을 막아 초점이 안 나가므로 여기 안 온다. 닫기는 suggestion을 통해(onExit이 속성을 뗀다).
      const editor = props.editor;
      const onBlur = ({ event }: { event: FocusEvent }) => {
        const next = event.relatedTarget as Node | null;
        if (next && popup?.contains(next)) return;
        exitSuggestion(editor.view, SLASH_SUGGESTION_KEY);
      };
      editor.on('blur', onBlur);
      offBlur = () => editor.off('blur', onBlur);
      root = createRoot(popup);
      root.render(
        <SlashMenu
          ref={(r) => { menuRef = r; }}
          items={props.items}
          categories={categories}
          query={props.query}
          command={(item) => { item.command(props.editor, props.range); }}
          idPrefix={idPrefix}
          listLabel={listLabel}
          editorDom={editorDom}
        />,
      );
    },
    onUpdate(props: {
      editor: Editor;
      range: Range;
      query: string;
      items: SlashMenuItem[];
      command: (item: SlashMenuItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) {
      if (popup) applyPosition(popup, props.clientRect);

      root?.render(
        <SlashMenu
          ref={(r) => { menuRef = r; }}
          items={props.items}
          categories={categories}
          query={props.query}
          command={(item) => { item.command(props.editor, props.range); }}
          idPrefix={idPrefix}
          listLabel={listLabel}
          editorDom={editorDom}
        />,
      );
    },
    onKeyDown(props: { event: KeyboardEvent }) {
      if (props.event.key === 'Escape') {
        popup?.remove();
        popup = null;
        root?.unmount();
        root = null;
        return true;
      }
      return menuRef?.onKeyDown(props.event) ?? false;
    },
    onExit() {
      offBlur?.();
      offBlur = null;
      clearSlashMenuAria(editorDom);
      editorDom = null;
      popup?.remove();
      popup = null;
      root?.unmount();
      root = null;
      menuRef = null;
    },
  };
}

// story ab2fd813(#2028) — 로케일 문자열을 주입받는 팩토리. doc-editor.tsx가
// useTranslations('docs.slashMenu')로 빌드한 SlashMenuStrings를 여기 넘긴다.
export function createSlashCommandExtension(strings: SlashMenuStrings) {
  const categories = buildSlashMenuCategories(strings);
  const items = categories.flatMap((c) => c.items);

  return Extension.create({
    name: 'slashCommand',

    addOptions() {
      return {
        suggestion: {
          char: '/',
          pluginKey: SLASH_SUGGESTION_KEY,
          items: ({ query }: { query: string }) => items.filter((item) => matchesSlashQuery(item, query)),
          render: () => createSuggestionRenderer(categories, strings.listLabel),
        } satisfies Partial<SuggestionOptions<SlashMenuItem>>,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
        }),
      ];
    },
  });
}
