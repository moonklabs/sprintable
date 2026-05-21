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
        command: (editor, range) => {
          const url = window.prompt('Image URL:');
          if (url) editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
        },
      },
      {
        title: 'File',
        description: '파일 첨부',
        icon: Paperclip,
        command: (editor, range) => {
          editor.chain().focus().deleteRange(range).run();
          const input = document.createElement('input');
          input.type = 'file';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const { MAX_FILE_BYTES: maxBytes, fileToDataUrl: toDataUrl, formatFileSize: fmtSize } = await import('./file-node');
            if (file.size > maxBytes) {
              window.dispatchEvent(new CustomEvent('docs:file-size-error', {
                detail: { message: `파일 크기가 5MB를 초과합니다. (${fmtSize(file.size)})` },
              }));
              return;
            }
            const dataUrl = await toDataUrl(file);
            editor.commands.insertContent({
              type: 'fileAttachment',
              attrs: { filename: file.name, size: file.size, mimeType: file.type, data: dataUrl },
            });
          };
          input.click();
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
            ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]'
            : 'text-[color:var(--operator-foreground)] hover:bg-white/6'
        }`}
        onClick={() => command(item)}
      >
        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border/60 ${isActive ? 'border-[color:var(--operator-primary)]/30 bg-[color:var(--operator-primary)]/10' : 'bg-muted/40'}`}>
          <Icon className={`size-3.5 ${isActive ? 'text-[color:var(--operator-primary-soft)]' : 'text-[color:var(--operator-muted)]'}`} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-xs font-medium leading-tight">{item.title}</span>
          <span className="truncate text-[11px] text-[color:var(--operator-muted)]">{item.description}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      ref={containerRef}
      className="max-h-72 w-64 overflow-y-auto rounded-xl border border-white/10 bg-[color:var(--operator-surface)] p-1 shadow-lg"
    >
      {grouped ? (
        grouped.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[color:var(--operator-muted)]">
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

function createSuggestionRenderer() {
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
          categories={slashMenuCategories}
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
          categories={slashMenuCategories}
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
        render: createSuggestionRenderer,
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
