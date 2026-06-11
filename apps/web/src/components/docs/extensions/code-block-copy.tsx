'use client';

import { useState, useCallback, useEffect, useRef, useId } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';
import { ChevronDown } from 'lucide-react';
import {
  getShikiHighlighter,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  LANGUAGE_LABELS,
} from '../lib/shiki-highlighter';
import { renderMermaid } from '../lib/mermaid-renderer';

// ─── Mermaid Block ───────────────────────────────────────────────────────────

function MermaidBlockView({ node, editor, selected }: ReactNodeViewProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  const code = node.textContent;
  const isEditable = editor?.isEditable ?? false;
  const showCode = isEditable && selected;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!code.trim()) {
        setSvg('');
        setError('');
        return;
      }
      try {
        const { svg: rendered } = await renderMermaid(code);
        if (!cancelled) { setSvg(rendered); setError(''); }
      } catch (err: unknown) {
        if (!cancelled) { setError(err instanceof Error ? err.message : '렌더링 실패'); setSvg(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  const handlePreviewClick = useCallback(() => {
    if (isEditable) editor?.commands.focus();
  }, [editor, isEditable]);

  return (
    <NodeViewWrapper className="my-4 not-prose" data-mermaid-id={id}>
      <div className="rounded-2xl border border-slate-700 bg-[#0b1120]">
        <div className="flex items-center justify-between px-3 py-2" contentEditable={false}>
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">mermaid</span>
          {isEditable && (
            <span className="text-[11px] text-slate-600">{showCode ? '코드 편집 중' : '클릭하여 편집'}</span>
          )}
        </div>

        {/* Code editor — visible when selected */}
        <pre className={`border-t border-slate-700/50 p-4 text-[13px] leading-6 text-slate-200 ${showCode ? '' : 'hidden'}`}>
          <NodeViewContent />
        </pre>

        {/* SVG preview — click triggers focus + selection to enter edit mode */}
        {!showCode && (
          <div
            className="px-4 pb-4"
            contentEditable={false}
            onClick={handlePreviewClick}
            style={{ cursor: isEditable ? 'pointer' : 'default' }}
          >
            {error ? (
              <div className="rounded-xl border border-destructive-border bg-destructive-tint p-3 text-xs text-destructive">
                {error}
              </div>
            ) : svg ? (
              <div
                dangerouslySetInnerHTML={{ __html: svg }}
                className="flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
              />
            ) : (
              <p className="text-xs text-slate-600">다이어그램을 입력하세요</p>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ─── Shiki Code Block View ────────────────────────────────────────────────────

function ShikiBlockView({ node, editor, selected }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState('');
  const [showLangMenu, setShowLangMenu] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  const language = (node.attrs as { language?: string }).language ?? null;
  const resolvedLang = resolveLanguage(language);
  const langLabel = language ? (LANGUAGE_LABELS[language] ?? language) : 'text';
  const code = node.textContent;
  const isEditable = editor?.isEditable ?? false;
  const isEditing = isEditable && selected;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const html = code.trim()
          ? await getShikiHighlighter().then((shiki) =>
              shiki.codeToHtml(code, { lang: resolvedLang, theme: 'dark-plus' }),
            )
          : '';
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        if (!cancelled) setHighlightedHtml('');
      }
    })();
    return () => { cancelled = true; };
  }, [code, resolvedLang]);

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
    } catch { /* clipboard unavailable */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [code]);

  const handleLangSelect = useCallback((lang: string) => {
    editor?.commands.updateAttributes('codeBlock', { language: lang });
    setShowLangMenu(false);
  }, [editor]);

  useEffect(() => {
    if (!showLangMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as HTMLElement)) {
        setShowLangMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showLangMenu]);

  return (
    <NodeViewWrapper className="my-4 not-prose">
      <div className="rounded-2xl border border-slate-700 bg-[#0b1120]">
        {/* Header: language selector + copy button */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          {/* Language dropdown */}
          <div ref={langMenuRef} className="relative" contentEditable={false}>
            <button
              type="button"
              onClick={() => isEditable && setShowLangMenu((v) => !v)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] transition ${
                isEditable
                  ? 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 cursor-pointer'
                  : 'text-slate-500 cursor-default'
              }`}
            >
              {langLabel}
              {isEditable && <ChevronDown className="size-3" />}
            </button>
            {showLangMenu && (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-36 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleLangSelect(lang)}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition hover:bg-slate-700/60 ${
                      lang === language ? 'text-blue-400' : 'text-slate-300'
                    }`}
                  >
                    {LANGUAGE_LABELS[lang] ?? lang}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Copy button */}
          <button
            type="button"
            contentEditable={false}
            onClick={handleCopy}
            className="rounded-full border border-slate-600 bg-slate-700/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300 transition hover:border-slate-400 hover:text-slate-100"
          >
            {copied ? '복사됨' : '복사'}
          </button>
        </div>

        {/* Code area */}
        <div className="overflow-x-auto px-4 pb-4">
          {/* Editing mode: show plain NodeViewContent */}
          <pre
            className={`text-[13px] leading-6 text-slate-200 ${isEditing || !highlightedHtml ? '' : 'hidden'}`}
          >
            <NodeViewContent />
          </pre>

          {/* Display mode: Shiki highlighted HTML */}
          {!isEditing && highlightedHtml && (
            <div
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              className="shiki-block [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:text-[13px] [&_pre]:leading-6 [&_pre]:!p-0 [&_code]:!bg-transparent"
              onClick={() => isEditable && editor?.commands.focus()}
              style={{ cursor: isEditable ? 'text' : 'default' }}
            />
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

function CodeBlockView(props: ReactNodeViewProps) {
  const language = (props.node.attrs as { language?: string }).language ?? null;
  if (language === 'mermaid') return <MermaidBlockView {...props} />;
  return <ShikiBlockView {...props} />;
}

export const CodeBlockWithCopy = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addAttributes() {
    return {
      language: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-language') ??
          (element.firstElementChild as HTMLElement | null)?.className.replace('language-', '') ??
          null,
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes['language']) return {};
          return {
            'data-language': attributes['language'],
            class: `language-${attributes['language']}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'pre', preserveWhitespace: 'full' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Mirror the language onto the <code> class as well as the <pre> — htmlToMarkdown
    // (Turndown) reads the fence language from the <code> class, so emitting it only on
    // <pre> dropped ```ts → ``` on the editor round-trip (story 2a72ebf4 FIX-3b).
    const language = (node.attrs as { language?: string }).language;
    const codeAttrs = language ? { class: `language-${language}` } : {};
    return ['pre', mergeAttributes(HTMLAttributes), ['code', codeAttrs, 0]];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-c': () => this.editor.commands.toggleNode(this.name, 'paragraph'),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
