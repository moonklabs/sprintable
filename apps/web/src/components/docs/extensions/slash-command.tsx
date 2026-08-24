'use client';

import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { createRoot, type Root } from 'react-dom/client';
import {
  forwardRef,
  useImperativeHandle,
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
  title: string;
  description: string;
  icon: FC<{ className?: string }>;
  command: (editor: Editor, range: Range) => void;
}

export interface SlashMenuCategory {
  label: string;
  items: SlashMenuItem[];
}

export const slashMenuCategories: SlashMenuCategory[] = [
  {
    label: '텍스트',
    items: [
      {
        title: 'Heading 1',
        description: '큰 제목',
        icon: Heading1,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
      },
      {
        title: 'Heading 2',
        description: '중간 제목',
        icon: Heading2,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
      },
      {
        title: 'Heading 3',
        description: '작은 제목',
        icon: Heading3,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
      },
    ],
  },
  {
    label: '리스트',
    items: [
      {
        title: 'Bullet List',
        description: '순서 없는 목록',
        icon: List,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleBulletList().run(),
      },
      {
        title: 'Ordered List',
        description: '순서 있는 목록',
        icon: ListOrdered,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
      },
      {
        title: 'Checklist',
        description: '체크리스트',
        icon: ListTodo,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleTaskList().run(),
      },
    ],
  },
  {
    label: '블록',
    items: [
      {
        title: 'Code Block',
        description: '코드 블록',
        icon: Code,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
      },
      {
        title: 'Blockquote',
        description: '인용구',
        icon: Quote,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
      },
      {
        title: 'Callout',
        description: '강조 박스',
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
        title: 'Table',
        description: '표 삽입',
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
    label: '미디어',
    items: [
      {
        title: 'Image',
        description: '이미지 삽입',
        icon: ImageIcon,
        // S4: URL prompt → 파일 피커 + Storage 업로드(asset ref). 다른 진입(gutter +·DnD·paste)과 동일 플로우.
        command: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          pickAndUpload(editor, 'image/*');
        },
      },
      {
        title: 'File',
        description: '파일 첨부',
        icon: Paperclip,
        // S4: base64 인라인 → Storage 업로드(asset ref).
        command: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          pickAndUpload(editor);
        },
      },
      {
        title: 'Embed',
        description: '외부 URL 임베드',
        icon: Globe,
        command: (editor, range) => {
          const url = window.prompt('임베드할 URL을 입력하세요 (YouTube, Figma 등):');
          editor.chain().focus().deleteRange(range).run();
          if (url?.trim()) {
            editor.commands.insertContent({ type: 'embedBlock', attrs: { url: url.trim() } });
          }
        },
      },
      {
        title: 'Mermaid Diagram',
        description: '다이어그램 삽입',
        icon: GitBranch,
        command: (editor, range) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'codeBlock',
              attrs: { language: 'mermaid' },
              content: [{ type: 'text', text: 'flowchart TD\n    A[시작] --> B[끝]' }],
            })
            .run(),
      },
    ],
  },
  {
    label: '고급',
    items: [
      {
        title: 'Columns',
        description: '2단/3단 컬럼 레이아웃',
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
        title: 'Math Block',
        description: 'LaTeX 블록 수식',
        icon: Sigma,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).insertContent({
            type: 'mathBlock',
            content: [{ type: 'text', text: 'E = mc^2' }],
          }).run(),
      },
      {
        title: 'Math Inline',
        description: 'LaTeX 인라인 수식',
        icon: Sigma,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).insertContent({
            type: 'mathInline',
            content: [{ type: 'text', text: 'x^2' }],
          }).run(),
      },
      {
        title: 'Toggle',
        description: '접기/펼치기 블록',
        icon: ChevronRight,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).insertContent({
            type: 'toggleBlock',
            attrs: { open: false },
            content: [
              { type: 'toggleSummary', content: [{ type: 'text', text: '토글 제목' }] },
              { type: 'toggleContent', content: [{ type: 'paragraph' }] },
            ],
          }).run(),
      },
      {
        title: 'Page Embed',
        description: '다른 문서 임베드',
        icon: FileText,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).insertPageEmbed().run(),
      },
      {
        title: 'Horizontal Rule',
        description: '구분선',
        icon: Minus,
        command: (editor, range) =>
          editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
      },
    ],
  },
];

export const defaultSlashItems: SlashMenuItem[] =
  slashMenuCategories.flatMap((c) => c.items);

// story ab2fd813(#2028) — 이 파일의 슬래시 팝업은 `createRoot(popup)`로 React 트리 밖(body
// append)에 렌더돼 `useTranslations`를 여기서 직접 못 쓴다. 그래서 로케일 문자열은 소비처
// (doc-editor.tsx, 이미 useTranslations 보유)가 빌드해 이 팩토리에 주입하는 형태로 뒤집는다.
// `slashMenuCategories`/`defaultSlashItems`(위, 한글 고정)는 그대로 둔다 — 기존
// `slash-command.test.tsx`의 `defaultSlashItems` 단언(영문 title)이 안 깨지게 하기 위한
// fallback 겸 하위호환 export다.
export interface SlashMenuStrings {
  categories: {
    text: string;
    list: string;
    block: string;
    media: string;
    advanced: string;
  };
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
  /** 선택 — 없으면 한글 기본값(시작/끝) 유지. 삽입되는 문서 콘텐츠라 UI chrome이 아님. */
  mermaidDefault?: { start: string; end: string };
  /** 선택 — 없으면 한글 기본값('토글 제목') 유지. */
  toggleDefaultTitle?: string;
}

/** `slashMenuCategories`와 구조는 동일, label/description/embed prompt/삽입 기본값만
 * `strings`에서 resolve한다 — icon·command 로직은 그대로 재사용. */
export function buildSlashMenuCategories(strings: SlashMenuStrings): SlashMenuCategory[] {
  const mermaidStart = strings.mermaidDefault?.start ?? '시작';
  const mermaidEnd = strings.mermaidDefault?.end ?? '끝';
  const toggleTitle = strings.toggleDefaultTitle ?? '토글 제목';

  return [
    {
      label: strings.categories.text,
      items: [
        {
          title: 'Heading 1',
          description: strings.items.heading1,
          icon: Heading1,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
        },
        {
          title: 'Heading 2',
          description: strings.items.heading2,
          icon: Heading2,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
        },
        {
          title: 'Heading 3',
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
          title: 'Bullet List',
          description: strings.items.bulletList,
          icon: List,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleBulletList().run(),
        },
        {
          title: 'Ordered List',
          description: strings.items.orderedList,
          icon: ListOrdered,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
        },
        {
          title: 'Checklist',
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
          title: 'Code Block',
          description: strings.items.codeBlock,
          icon: Code,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
        },
        {
          title: 'Blockquote',
          description: strings.items.blockquote,
          icon: Quote,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
        },
        {
          title: 'Callout',
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
          title: 'Table',
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
          title: 'Image',
          description: strings.items.image,
          icon: ImageIcon,
          command: (editor, range) => {
            editor.chain().focus().deleteRange(range).run();
            pickAndUpload(editor, 'image/*');
          },
        },
        {
          title: 'File',
          description: strings.items.file,
          icon: Paperclip,
          command: (editor, range) => {
            editor.chain().focus().deleteRange(range).run();
            pickAndUpload(editor);
          },
        },
        {
          title: 'Embed',
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
          title: 'Mermaid Diagram',
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
          title: 'Columns',
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
          title: 'Math Block',
          description: strings.items.mathBlock,
          icon: Sigma,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'mathBlock',
              content: [{ type: 'text', text: 'E = mc^2' }],
            }).run(),
        },
        {
          title: 'Math Inline',
          description: strings.items.mathInline,
          icon: Sigma,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertContent({
              type: 'mathInline',
              content: [{ type: 'text', text: 'x^2' }],
            }).run(),
        },
        {
          title: 'Toggle',
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
          title: 'Page Embed',
          description: strings.items.pageEmbed,
          icon: FileText,
          command: (editor, range) =>
            editor.chain().focus().deleteRange(range).insertPageEmbed().run(),
        },
        {
          title: 'Horizontal Rule',
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

const SlashMenu = forwardRef<
  SlashMenuRef,
  {
    items: SlashMenuItem[];
    categories: SlashMenuCategory[];
    query: string;
    command: (item: SlashMenuItem) => void;
  }
>(function SlashMenu({ items, categories, query, command }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const safeIndex = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;

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

  if (items.length === 0) return null;

  const grouped = query === '' ? groupByCategory(items, categories) : null;

  const renderItem = (item: SlashMenuItem, flatIndex: number) => {
    const isActive = flatIndex === safeIndex;
    const Icon = item.icon;
    return (
      <button
        key={item.title}
        type="button"
        data-active={isActive}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
          isActive
            ? 'bg-brand/14 text-[color:var(--brand-soft)]'
            : 'text-foreground hover:bg-white/6'
        }`}
        onClick={() => command(item)}
      >
        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 ${isActive ? 'border-brand/30 bg-brand/10' : 'bg-muted/40'}`}>
          <Icon className={`size-3.5 ${isActive ? 'text-[color:var(--brand-soft)]' : 'text-muted-foreground'}`} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs font-medium leading-tight">{item.title}</span>
          <span className="truncate text-[11px] text-muted-foreground">{item.description}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      ref={containerRef}
      // story #3007(로드맵 P2·PR-E, L1) — 슬래시메뉴는 floating이라 --elev-overlay.
      className="max-h-72 w-64 overflow-y-auto rounded-xl border border-white/10 bg-card p-1 shadow-[var(--elev-overlay)]"
    >
      {grouped ? (
        grouped.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              {group.label}
            </p>
            {group.items.map((item) => {
              const flatIndex = items.indexOf(item);
              return renderItem(item, flatIndex);
            })}
          </div>
        ))
      ) : (
        items.map((item, index) => renderItem(item, index))
      )}
    </div>
  );
});

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

function createSuggestionRenderer(categories: SlashMenuCategory[]) {
  let popup: HTMLElement | null = null;
  let root: Root | null = null;
  let menuRef: SlashMenuRef | null = null;

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

      root = createRoot(popup);
      root.render(
        <SlashMenu
          ref={(r) => { menuRef = r; }}
          items={props.items}
          categories={categories}
          query={props.query}
          command={(item) => { item.command(props.editor, props.range); }}
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
      popup?.remove();
      popup = null;
      root?.unmount();
      root = null;
      menuRef = null;
    },
  };
}

/** 하위호환 fallback(한글 고정) — 로케일 인지 소비처는 `createSlashCommandExtension`을 쓴다. */
export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        items: ({ query }: { query: string }) =>
          defaultSlashItems.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase()),
          ),
        render: () => createSuggestionRenderer(slashMenuCategories),
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
          items: ({ query }: { query: string }) =>
            items.filter((item) =>
              item.title.toLowerCase().includes(query.toLowerCase()),
            ),
          render: () => createSuggestionRenderer(categories),
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
