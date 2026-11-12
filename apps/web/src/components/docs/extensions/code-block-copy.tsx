'use client';

import { useState, useCallback, useEffect, useRef, useId } from 'react';
import { useTranslations } from 'next-intl';
import { mergeAttributes } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';
import { ChevronDown } from 'lucide-react';
import {
  getShikiHighlighter,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  LANGUAGE_LABELS,
} from '../lib/shiki-highlighter';
import { renderMermaid } from '../lib/mermaid-renderer';
import { copyTextSafely } from '@/lib/clipboard';
import { useViewportClampRef } from '@/hooks/use-viewport-clamp';
import { usePortalMenuKeys } from '@/components/shared/anchored-popover';

// ─── Mermaid Block ───────────────────────────────────────────────────────────

function MermaidBlockView({ node, editor, selected }: ReactNodeViewProps) {
  const t = useTranslations('docs');
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
        if (!cancelled) { setError(err instanceof Error ? err.message : t('mermaidRenderFailed')); setSvg(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [code, t]);

  const handlePreviewClick = useCallback(() => {
    if (isEditable) editor?.commands.focus();
  }, [editor, isEditable]);

  return (
    <NodeViewWrapper className="my-4 not-prose" data-mermaid-id={id}>
      <div className="rounded-xl border border-border bg-muted">
        <div className="flex items-center justify-between px-3 py-2" contentEditable={false}>
          <span className="text-editorial-meta font-medium text-muted-foreground">mermaid</span>
          {isEditable && (
            <span className="text-editorial-meta text-muted-foreground">{showCode ? t('mermaidEditingCode') : t('mermaidClickToEdit')}</span>
          )}
        </div>

        {/* Code editor — visible when selected */}
        <pre className={`border-t border-border p-4 text-xs leading-6 text-foreground ${showCode ? '' : 'hidden'}`}>
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
            {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
            {error ? (
              <div
                className="rounded-xl border border-destructive-border bg-destructive-tint p-3 text-xs text-foreground"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                {error}
              </div>
            ) : svg ? (
              <div
                dangerouslySetInnerHTML={{ __html: svg }}
                className="flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t('mermaidPlaceholder')}</p>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ─── Shiki Code Block View ────────────────────────────────────────────────────

function ShikiBlockView({ node, editor, selected, updateAttributes }: ReactNodeViewProps) {
  // story #3776(1층B) — "복사됨"/"복사", docs ns의 기존 codeCopied/codeCopy 키 재사용.
  const t = useTranslations('docs');
  const [copied, setCopied] = useState(false);
  // story #3986(클래스 «거짓 성공 표시») — 옛 코드는 실패해도 무조건 setCopied
  // (true)였다. 코드 자체는 이 블록에 이미 선택 가능하게 떠 있다.
  const [copyFailed, setCopyFailed] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState('');
  const [showLangMenu, setShowLangMenu] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const langButtonRef = useRef<HTMLButtonElement>(null);
  const langListClampRef = useViewportClampRef<HTMLDivElement>(); // story #4342 — 좁은 화면 뷰포트 안으로
  // story #4364 — 목록의 키보드 길 · ARIA는 공용 훅 하나(4349): Esc = 닫고 이 블록 트리거로 · 열면 첫 항목 초점 · ↑↓ ·
  // 트리거 aria-haspopup/expanded/controls · 목록 role=menu.
  const langListRef = useRef<HTMLDivElement | null>(null);
  const setLangList = useCallback((el: HTMLDivElement | null) => { langListRef.current = el; langListClampRef(el); }, [langListClampRef]);
  const closeLangMenu = useCallback(() => setShowLangMenu(false), []);
  const langKeys = usePortalMenuKeys({
    open: showLangMenu, onClose: closeLangMenu, popoverRef: langListRef, triggerRef: langButtonRef, kind: 'menu',
  });

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
    const result = await copyTextSafely(code);
    if (!result.ok) {
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 1600);
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [code]);

  const handleLangSelect = useCallback((lang: string) => {
    // story #4360 — 이 고르개가 붙은 블록(NodeView 자기 위치)의 언어를 바꾼다. 예전 `editor.commands.updateAttributes('codeBlock', …)`는
    // **지금 선택 영역**의 코드 블록을 바꿔, 커서가 다른 코드 블록에 있으면 그 블록의 언어가 바뀌었다.
    // 고른 선택지는 목록과 함께 사라진다 — 초점이 body로 떨어지지 않게 이 블록의 언어 버튼으로 돌려놓는다(키보드로 이어서 쓸 수 있게).
    // 단 초점이 아직 이 고르개 안(또는 body · 없음)일 때만 — 사용자가 그 사이 딴 데로 옮긴 초점은 빼앗지 않는다(까디르 09-27).
    const active = document.activeElement;
    const focusStillHere = !active || active === document.body || (langMenuRef.current?.contains(active) ?? false);
    updateAttributes({ language: lang });
    setShowLangMenu(false);
    if (focusStillHere) langButtonRef.current?.focus();
  }, [updateAttributes]);

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
      <div className="rounded-xl border border-border bg-muted">
        {/* Header: language selector + copy button */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          {/* Language dropdown */}
          <div ref={langMenuRef} className="relative" contentEditable={false}>
            <button
              ref={langButtonRef}
              type="button"
              onClick={() => isEditable && setShowLangMenu((v) => !v)}
              onKeyDown={langKeys.onTriggerKeyDown}
              {...(isEditable ? langKeys.triggerProps : {})}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-editorial-meta font-medium transition ${
                isEditable
                  ? 'text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer'
                  : 'text-muted-foreground cursor-default'
              }`}
            >
              {langLabel}
              {isEditable && <ChevronDown className="size-3" />}
            </button>
            {showLangMenu && (
              <div ref={setLangList} onKeyDown={langKeys.onPopoverKeyDown} {...langKeys.popoverProps} data-dropdown-panel="code-lang" className="focus-inset absolute left-0 top-full z-50 mt-1 max-h-52 w-36 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover py-1">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    role="menuitemradio"
                    aria-checked={lang === language}
                    onClick={() => handleLangSelect(lang)}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition hover:bg-accent ${
                      lang === language ? 'text-primary' : 'text-foreground'
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
            className="rounded-md border border-border bg-card px-3 py-1.5 text-editorial-meta font-medium text-muted-foreground transition hover:text-foreground"
          >
            {copyFailed ? t('codeCopyFailed') : copied ? t('codeCopied') : t('codeCopy')}
          </button>
        </div>

        {/* Code area */}
        {/* story #2165: 코드블럭은 전역 스크롤바 숨김의 예외 — 가로로 잘린 줄이 있다는 것을
            스크롤바로 알려야 한다. */}
        <div className="scrollbar-visible overflow-x-auto px-4 pb-4">
          {/* Editing mode: show plain NodeViewContent */}
          <pre
            className={`text-xs leading-6 text-foreground ${isEditing || !highlightedHtml ? '' : 'hidden'}`}
          >
            <NodeViewContent />
          </pre>

          {/* Display mode: Shiki highlighted HTML */}
          {!isEditing && highlightedHtml && (
            <div
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              className="shiki-block [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:text-xs [&_pre]:leading-6 [&_pre]:!p-0 [&_code]:!bg-transparent"
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

/**
 * 4914 — 코드 블록 = 복사 단추 · 언어 고르개 · Mermaid 보기를 입힌 «코드 블록 확장 자체의 이어받음(extend)».
 * 예전(2026-04-18 218ed0cea)엔 `Node.create`로 노드를 새로 만들었다 — 그러면 TipTap 코드 블록이 거저 주는 것(`toggleCodeBlock` · `setCodeBlock` 명령, ``` · ~~~ 입력 규칙,
 * Mod-Alt-c · Backspace · 세 번 Enter · ↓ 로 나가기, VS Code 붙여넣기)이 하나도 없어 «/코드 블록» · 도구줄 단추가 `toggleCodeBlock is not a function`으로 던졌고
 * ```로도 새 코드 블록을 못 만들었다(기존 문서에서 불러온 것만 보임 — 7개월).
 * 그래서 명령 · 규칙 · 단축키는 손으로 덧붙이지 않고 확장에서 그대로 받고, 여기서는 이 화면이 «다르게» 하는 것만 덮는다:
 * 언어 속성을 `data-language`(pre)와 `<code class="language-…">` 양쪽에서 읽고 쓰는 것(FIX-3b — Turndown이 펜스 언어를 `<code>` 클래스에서 읽는다) · 노드 뷰.
 * 노드 이름은 `codeBlock` 그대로(저장된 문서 · 왕복 시험 · `editor.isActive('codeBlock')`).
 */
export const CodeBlockWithCopy = CodeBlock.extend({
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

  // 4914 — 확장이 거저 주는 «VS Code 붙여넣기 → 코드 블록» 플러그인은 싣지 않는다: 이 편집기에 전에 없던 붙여넣기 길이고(요구 밖), 붙여넣기 글에 든
  // `vscode-editor-data`를 검사 없이 `JSON.parse`해 틀린 값이 오면 붙여넣기 자체가 던진다(codex 1차). 명령 · ``` 규칙 · 단축키만 받는다.
  addProseMirrorPlugins() {
    return [];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
