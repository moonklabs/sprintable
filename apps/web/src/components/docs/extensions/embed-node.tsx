'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { ExternalLink, Link2 } from 'lucide-react';

// ─── URL Helpers ──────────────────────────────────────────────────────────────

type EmbedService = 'youtube' | 'figma' | 'fallback';

interface EmbedInfo {
  type: EmbedService;
  embedUrl: string;
}

// story #2809(페드루군 AC 지적) — hostname.includes('youtube.com')류 부분일치는 hostname이
// 정확히 그 도메인이거나 그 서브도메인일 때만 참이어야 한다(느슨한 substring 매치는
// "notyoutube.com" 같은 오탐도 통과시킨다 — CSP가 뒷단에서 막아 보안 구멍은 아니지만
// 판정 자체가 틀리다).
function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectEmbedService(url: string): EmbedInfo {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return { type: 'fallback', embedUrl: url };

    // YouTube — CSP frame-src가 정확히 `https://www.youtube.com`만 허용하므로(story #2809),
    // 입력이 어떤 형태든(youtube.com·music.youtube.com·이미 /embed/ 경로 등) 항상 그
    // canonical origin으로 재작성해야 한다 — 원본 URL을 그대로 통과시키면(구 코드, 페드루군
    // AC 지적) www 없는 호스트나 서브도메인 /embed/ URL이 CSP에 막혀 조용히 백지가 된다.
    const isYoutubeHost = isDomainOrSubdomain(parsed.hostname, 'youtube.com');
    const ytVideoId = isYoutubeHost
      ? (parsed.searchParams.get('v') ?? (parsed.pathname.startsWith('/embed/') ? parsed.pathname.slice('/embed/'.length) : null))
      : parsed.hostname === 'youtu.be'
        ? parsed.pathname.slice(1)
        : null;
    if (ytVideoId) {
      return { type: 'youtube', embedUrl: `https://www.youtube.com/embed/${ytVideoId}` };
    }

    // Figma
    if (
      isDomainOrSubdomain(parsed.hostname, 'figma.com') &&
      /^\/(file|design|proto)\//.test(parsed.pathname)
    ) {
      return {
        type: 'figma',
        embedUrl: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`,
      };
    }
  } catch { /* invalid URL */ }

  return { type: 'fallback', embedUrl: url };
}

// ─── Embed View ───────────────────────────────────────────────────────────────

function EmbedView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const url = (node.attrs.url as string) ?? '';
  const [editUrl, setEditUrl] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setEditUrl(url); }, [url]);

  const applyUrl = useCallback(() => {
    const trimmed = editUrl.trim();
    if (trimmed) updateAttributes({ url: trimmed });
  }, [editUrl, updateAttributes]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); applyUrl(); }
    if (e.key === 'Escape') setEditUrl(url);
  }, [applyUrl, url]);

  const { type, embedUrl } = detectEmbedService(url);

  return (
    <NodeViewWrapper as="div" className="my-4 not-prose" contentEditable={false}>
      {/* URL editor — visible when block is selected */}
      {selected && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand/6 px-3 py-2">
          <Link2 className="size-3.5 flex-shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={applyUrl}
            placeholder="URL 입력 후 Enter"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}

      {/* Embed content */}
      {url ? (
        <>
          {type === 'youtube' && (
            <div className="aspect-video w-full overflow-hidden rounded-xl border border-border">
              <iframe
                src={embedUrl}
                title="YouTube video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="h-full w-full"
              />
            </div>
          )}
          {type === 'figma' && (
            <div className="h-[480px] w-full overflow-hidden rounded-xl border border-border">
              <iframe
                src={embedUrl}
                title="Figma embed"
                allow="fullscreen"
                allowFullScreen
                className="h-full w-full"
              />
            </div>
          )}
          {type === 'fallback' && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm transition-colors hover:bg-muted/40"
            >
              <ExternalLink className="size-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground/80">{url}</span>
            </a>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
          <Link2 className="size-4" />
          <span>블록을 선택해 URL을 입력하세요</span>
        </div>
      )}
    </NodeViewWrapper>
  );
}

// ─── Node Definition ──────────────────────────────────────────────────────────

export const EmbedBlock = Node.create({
  name: 'embedBlock',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embedBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { url, ...rest } = HTMLAttributes as Record<string, unknown>;
    return ['div', mergeAttributes({ 'data-type': 'embedBlock', 'data-url': url }, rest)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});
