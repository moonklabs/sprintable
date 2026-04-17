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

export interface SlashMenuItem {
  title: string;
  icon: string;
  command: (editor: Editor, range: Range) => void;
}

export const defaultSlashItems: SlashMenuItem[] = [
  {
    title: 'Heading 1',
    icon: 'H1',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    icon: 'H2',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    icon: 'H3',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    icon: '•',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Ordered List',
    icon: '1.',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Code Block',
    icon: '<>',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Blockquote',
    icon: '"',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Callout',
    icon: '💡',
    command: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: 'callout',
          content: [{ type: 'paragraph' }],
        })
        .run(),
  },
  {
    title: 'Table',
    icon: '⊞',
    command: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: 'Image',
    icon: '🖼',
    command: (editor, range) => {
      const url = window.prompt('Image URL:');
      if (url) {
        editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
      }
    },
  },
  {
    title: 'Horizontal Rule',
    icon: '—',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Page Embed',
    icon: '📄',
    command: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertPageEmbed().run(),
  },
];

interface SlashMenuRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const SlashMenu = forwardRef<
  SlashMenuRef,
  { items: SlashMenuItem[]; command: (item: SlashMenuItem) => void }
>(function SlashMenu({ items, command }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clamp index when items shrink; reset handled via keyboard navigation
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
        const idx = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;
        const item = items[idx];
        if (item) command(item);
        return true;
      }
      return false;
    },
    [items, selectedIndex, command],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown]);

  if (items.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-[color:var(--operator-surface)] p-1 shadow-lg"
    >
      {items.map((item, index) => (
        <button
          key={item.title}
          type="button"
          data-active={index === safeIndex}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
            index === safeIndex
              ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]'
              : 'text-[color:var(--operator-foreground)] hover:bg-white/6'
          }`}
          onClick={() => command(item)}
        >
          <span className="w-5 text-center text-xs font-bold text-[color:var(--operator-muted)]">
            {item.icon}
          </span>
          <span>{item.title}</span>
        </button>
      ))}
    </div>
  );
});

/** Estimated max-height of the dropdown (matches `max-h-64` = 16rem at 16px/rem). */
const MENU_ESTIMATED_HEIGHT = 256;
/** Estimated min-width of the dropdown for initial right-edge clamping. */
const MENU_ESTIMATED_WIDTH = 240;
/** Gap between caret anchor and popup edge, in px. */
const CARET_GAP = 4;
/** Minimum distance from viewport edges, in px. */
const VIEWPORT_MARGIN = 8;

/**
 * Pure function that computes the {top, left} for the slash-hint popup so it
 * stays fully within the viewport regardless of scroll position.
 *
 * - Prefers positioning below the caret anchor.
 * - Flips above when insufficient space below and more space is available above.
 * - Clamps both axes to stay within the viewport.
 *
 * Exported for unit testing.
 */
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
    // Enough room below, or more room below than above → open downward
    top = anchorRect.bottom + CARET_GAP;
  } else {
    // Flip upward
    top = anchorRect.top - CARET_GAP - popupHeight;
  }

  // Clamp vertically so the popup never extends outside the viewport
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportHeight - popupHeight - VIEWPORT_MARGIN));

  // Clamp horizontally
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchorRect.left, viewportWidth - popupWidth - VIEWPORT_MARGIN),
  );

  return { top, left };
}

/**
 * Applies viewport-aware positioning to the popup element.
 *
 * 1. Computes an initial position with estimated dimensions (no flash).
 * 2. After React has flushed the render (double rAF), re-measures the actual
 *    popup dimensions and fine-tunes the position.
 */
function applyPosition(
  popup: HTMLElement,
  clientRectFn: (() => DOMRect | null) | null | undefined,
): void {
  const rect = clientRectFn?.();
  if (!rect) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Initial estimate — avoids visible jump on first render
  const initial = calculatePopupPosition(rect, MENU_ESTIMATED_HEIGHT, MENU_ESTIMATED_WIDTH, vw, vh);
  popup.style.top = `${initial.top}px`;
  popup.style.left = `${initial.left}px`;

  // Fine-tune after React's concurrent render has painted (double rAF)
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
          ref={(r) => {
            menuRef = r;
          }}
          items={props.items}
          command={(item) => {
            item.command(props.editor, props.range);
          }}
        />,
      );
    },
    onUpdate(props: {
      editor: Editor;
      range: Range;
      items: SlashMenuItem[];
      command: (item: SlashMenuItem) => void;
      clientRect?: (() => DOMRect | null) | null;
    }) {
      if (popup) {
        applyPosition(popup, props.clientRect);
      }

      root?.render(
        <SlashMenu
          ref={(r) => {
            menuRef = r;
          }}
          items={props.items}
          command={(item) => {
            item.command(props.editor, props.range);
          }}
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
