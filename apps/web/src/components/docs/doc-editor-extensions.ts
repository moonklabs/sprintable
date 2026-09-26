/**
 * story #4339 — 문서 편집기가 쓰는 Tiptap 확장 목록 **한 곳**. 편집기(doc-editor.tsx)와 왕복 테스트(doc-editor-roundtrip.test.ts)가 같은 목록을
 * 쓴다 — 테스트가 손으로 고른 일부만 쓰면, 실제 편집기에만 있는 확장이 부품을 먼저 잡아가는 결함을 못 본다.
 *
 * 순서가 뜻을 가진다(Tiptap은 같은 우선순위의 parseHTML 규칙을 등록 순서대로 본다) — 옮길 때 순서를 바꾸지 않는다.
 */
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import type { AnyExtension } from '@tiptap/core';
import { CustomImageNode } from './extensions/image-node';
import { ImageUploadExtension } from './extensions/image-upload';
import { CalloutNode } from './extensions/callout-node';
import { createSlashCommandExtension, type SlashMenuStrings } from './extensions/slash-command';
import { PageEmbedExtension } from './extensions/page-embed-node';
import { CodeBlockWithCopy } from './extensions/code-block-copy';
import { ToggleBlock, ToggleSummary, ToggleContent } from './extensions/toggle-block';
import { FileAttachmentNode } from './extensions/file-node';
import { EmbedBlock } from './extensions/embed-node';
import { MathBlockNode, MathInlineNode } from './extensions/math-node';
import { ColumnsBlock, ColumnBlock } from './extensions/column-layout';
import { WikiLinkNode, createWikiLinkSuggestion } from './extensions/wiki-link';
import { StoryMentionExtension, EntityLinkExtension } from './extensions/story-mention';
import { HeadingIds } from './extensions/heading-ids';

export interface DocEditorExtensionOptions {
  placeholder: string;
  projectId?: string;
  currentDocId?: string;
  onNavigate?: (slug: string) => void;
  wikiLinkNotFoundLabel: string;
  storyPickerEmptyLabel: string;
  slashMenuStrings: SlashMenuStrings;
}

export function createDocEditorExtensions(opts: DocEditorExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false }),
    CodeBlockWithCopy,
    // story #3866 — entity:story: 프로토콜 허용+isAllowedUri 검증+칩 스타일까지 포함한
    // Link 확장(상세는 story-mention.tsx 주석). 재구현 0 — 그 파일 하나에 설정을 모은다.
    EntityLinkExtension,
    CustomImageNode,
    ImageUploadExtension,
    Highlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    Placeholder.configure({
      placeholder: opts.placeholder,
      showOnlyCurrent: false,
      includeChildren: true,
    }),
    CalloutNode,
    ToggleBlock,
    ToggleSummary,
    ToggleContent,
    FileAttachmentNode,
    EmbedBlock,
    MathBlockNode,
    MathInlineNode,
    ColumnsBlock,
    ColumnBlock,
    WikiLinkNode.configure({
      projectId: opts.projectId,
      onNavigate: opts.onNavigate,
      suggestion: createWikiLinkSuggestion(opts.projectId, opts.wikiLinkNotFoundLabel),
    }),
    // story #3866 — 문서에 스토리를 "붙이는" `#` 트리거(wikiLink의 `[[`와 동형 패턴).
    // 새 Node가 아니라 위 Link mark로 진짜 앵커를 삽입(3858 파서 요구 형식).
    StoryMentionExtension.configure({
      projectId: opts.projectId,
      emptyLabel: opts.storyPickerEmptyLabel,
    }),
    createSlashCommandExtension(opts.slashMenuStrings),
    PageEmbedExtension.configure({ currentDocId: opts.currentDocId, onNavigate: opts.onNavigate }),
    // story #4339 — 제목 앵커 id(목차 이동)는 decoration으로 — 편집기 DOM을 직접 고치면 ProseMirror가 사용자 편집으로 다시 읽는다.
    HeadingIds,
  ];
}
