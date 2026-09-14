'use client';

import { useState, useEffect } from 'react';
import { Extension, mergeAttributes } from '@tiptap/core';
import LinkExtension from '@tiptap/extension-link';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { createRoot, type Root } from 'react-dom/client';
import { resolveEntityIcon, EntityGlyph } from '@/components/chat/entity-registry';
import { fetchWithAuth } from '@/lib/db/client';
import { parseEntitySearchResults } from '@/hooks/use-entity-picker';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// story #3866(페드루 판정 2026-09-14 11:45Z) — 채팅 EntityChip과 같은 아이콘 SSOT
// (entity-registry.ts::ENTITY_ICONS.story) 재사용 — 직접 lucide-react에서 고르지 않는다
// (그 표가 바뀌면 이 드롭다운도 같이 바뀌어야 드리프트가 없다). 모듈 스코프에서 미리
// resolve(react-hooks/static-components 규율 — 렌더 스코프 안에서 lookup한 컴포넌트를
// 바로 JSX로 못 쓴다, entity-registry.ts 자체 주석과 동형).
const STORY_ICON = resolveEntityIcon('story');

// 3858 파서(mention_parser.py `_DOC_ENTITY_HREF_RE`)가 읽는 정확한 형식만 — 임의 entity:*
// 문자열이 앵커로 굳는 것을 막는다(스킴만 여는 것보다 엄격).
const ENTITY_HREF_RE = /^entity:[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** story #3866(페드루 판정 2026-09-14 10:48Z) — @tiptap/extension-link의 프로토콜
 * 화이트리스트(http·https·ftp·ftps·mailto·tel·callto·sms·cid·xmpp)에 `entity`가 없어
 * parseHTML(a[href])·renderHTML·setLink 셋 다 `entity:story:…` href를 거부한다(잠복
 * 결함: 이미 entity 링크가 든 마크다운 문서를 에디터에 열면 Link parseHTML false → 앵커가
 * 평문으로 떨어져 저장 시 링크가 소실된다). protocols로 스킴을 열고, isAllowedUri로 정확한
 * 형식만 통과시킨다. renderHTML도 확장해 entity: 링크만 칩 스타일(AC3 캡처 요구)로 — 새
 * 노드 타입 0(여전히 Link mark 하나), EntityChip(chat/embed-card.tsx)의 무거운 상태조회·
 * 모달까지는 이 에디터 인라인 자리에 안 맞아(그라운딩 §3) 시각 언어만 가볍게 재현한다. */
export const EntityLinkExtension = LinkExtension.extend({
  renderHTML({ HTMLAttributes, mark }) {
    const href = HTMLAttributes.href as string | undefined;
    if (typeof href === 'string' && href.startsWith('entity:')) {
      return [
        'a',
        mergeAttributes(HTMLAttributes, {
          class: 'inline-flex items-center gap-1 rounded px-1 py-0.5 text-sm no-underline bg-muted text-foreground hover:brightness-95',
        }),
        0,
      ];
    }
    return this.parent?.({ HTMLAttributes, mark }) ?? ['a', HTMLAttributes, 0];
  },
}).configure({
  openOnClick: false,
  protocols: [{ scheme: 'entity' }],
  isAllowedUri: (url, ctx) => {
    if (/^entity:/.test(url)) return ENTITY_HREF_RE.test(url);
    return ctx.defaultValidate(url);
  },
});

// story #3866(UX-v3·customer-zero·연결 쓰기 UI, 2026-09-14) — 문서 에디터에 "스토리를
// 붙이는" 입력을 연다. 채팅의 `#`-검색 mention과 같은 결로: 검색 API(`/api/entities/search`,
// project 스코프)와 토큰 포맷(`[title](entity:type:id)`)만 재사용하고(chat-input-entity-
// tokens.ts는 diff 0 — AC3가 그 파일을 "참조 코어"로 못 박는다), 에디터 쪽 삽입 메커니즘은
// wiki-link.tsx의 `[[` 트리거 Suggestion 패턴을 그대로 복제한다.
//
// ⛔wikiLink처럼 커스텀 Node(§span[data-type])로 만들지 않는다 — 3858 파서(mention_parser.py
// `_DOC_ENTITY_HREF_RE`)는 **`<a href="entity:type:uuid">` 앵커만** 인식하고, wikiLink의
// span 경로는 doc 전용 별도 분기라 story엔 안 먹는다(AC0 실측). 대신 에디터에 이미 있는
// `Link` mark(@tiptap/extension-link)로 진짜 앵커를 삽입 — Turndown 기본 규칙이 앵커를
// `[text](href)`로 그대로 직렬화하니 BE·Turndown 변경 0(단, content-converter.ts의 읽기
// 쪽 markdownToHtml 정규식은 손댔다 — 균형 대괄호 제목 지원, 아래 sanitize 관련 주석 참고).
//
// story #3866(페드루 판정 2026-09-14 11:45Z, PO CHANGES) — title은 원문 그대로 삽입한다.
// 초안은 title의 `]`가 content-converter.ts의 홈그로운 markdownToHtml 정규식(균형 대괄호를
// 못 견딤)에 걸려 저장 시 링크가 평문으로 깨지는 걸 피하려고 대괄호를 괄호로 치환했지만,
// 이건 "칩에 보이는 낱말≠스토리 실제 제목" 위반이다(같은 사실은 같은 낱말로). 근본 처방은
// 텍스트 쪽이 아니라 파서 쪽 — content-converter.ts의 정규식이 1단 균형 대괄호(그리고
// sprintable reference_token이 쓰는 백슬래시 이스케이프 형식)를 링크 텍스트로 허용하도록
// 고쳤다(그 파일 460행 부근). title 변형은 이제 필요 0.

export interface StoryResult {
  id: string;
  title: string;
}

export function StoryMentionMenu({
  items,
  command,
  emptyLabel,
}: {
  items: StoryResult[];
  command: (item: StoryResult) => void;
  /** wiki-link.tsx WikiLinkMenu와 동형 — 이 팝업은 createRoot()로 앱 React 트리 밖에 뜨므로
   * (NextIntlClientProvider 없이) useTranslations를 여기서 못 쓴다. 호출부(doc-editor.tsx,
   * 훅 컨텍스트 有)에서 이미 번역된 문자열로 받는다. */
  emptyLabel: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1)); e.preventDefault(); }
      if (e.key === 'ArrowUp') { setSelectedIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1)); e.preventDefault(); }
      if (e.key === 'Enter') { const item = items[selectedIndex]; if (item) { command(item); } e.preventDefault(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [items, selectedIndex, command]);

  // story #3866(§DS 게이트 A/카드) — 손코딩 border+rounded+bg-card 대신 Card(surface='solid'
  // → border-border/80 bg-card)로. 떠있는 팝업 특유의 옅은 테두리·elev 그림자는 className
  // 덮어쓰기(twMerge가 border-border/80→border-white/10로 충돌 해소)로 유지 — wiki-link.tsx·
  // slash-command.tsx의 팝업(이 파일보다 먼저 생겨 가드 baseline에 이미 잡힌 손코딩)과 같은
  // 시각 언어를 Card 프리미티브로 재현한다(신규 파일이라 새 손코딩을 늘리지 않는다).
  if (items.length === 0) {
    return (
      <Card surface="solid" radius="compact" className="w-56 border-white/10 p-3 text-xs text-muted-foreground shadow-[var(--elev-overlay)]">
        {emptyLabel}
      </Card>
    );
  }

  return (
    <Card surface="solid" radius="compact" className="max-h-64 w-56 overflow-y-auto border-white/10 p-1 shadow-[var(--elev-overlay)]">
      {items.map((item, i) => (
        <Button
          key={item.id}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => command(item)}
          className={`h-auto w-full justify-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-normal ${
            i === selectedIndex
              ? 'bg-primary/10 text-primary'
              : 'text-foreground'
          }`}
        >
          <EntityGlyph Icon={STORY_ICON} label={item.title} className="size-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-xs">{item.title}</span>
        </Button>
      ))}
    </Card>
  );
}

export function createStoryMentionSuggestion(
  projectId: string | undefined,
  emptyLabel: string,
): Partial<SuggestionOptions> {
  let popup: HTMLElement | null = null;
  let root: Root | null = null;

  return {
    char: '#',
    allowSpaces: false,
    startOfLine: false,

    items: async ({ query }) => {
      if (!projectId) return [];
      try {
        // AC1 — story만(entities.py `types=` 필터, 다른 종류 후보 요청 자체를 안 해 낭비 0).
        // entities.py는 limit 쿼리파라미터를 안 받는다(DEFAULT_LIMIT=10 서버 상수 고정) — 안 보낸다.
        const params = new URLSearchParams({ project_id: projectId, types: 'story' });
        if (query) params.set('q', query);
        const res = await fetchWithAuth(`/api/entities/search?${params.toString()}`);
        if (!res.ok) return [];
        const json: unknown = await res.json();
        // use-entity-picker.ts의 parseEntitySearchResults 재사용 — FE 프록시가 한 겹 더
        // 감싸는 {data:{data,types}} 모양을 이미 아는 자리(회귀: story #2263 BE 계약②).
        return parseEntitySearchResults(json)
          .filter((r) => r.entity_type === 'story')
          .map((r) => ({ id: r.entity_id, title: r.title }));
      } catch {
        return [];
      }
    },

    render: () => ({
      onStart(props) {
        popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;z-index:9999';
        document.body.appendChild(popup);

        const rect = props.clientRect?.();
        if (rect) {
          popup.style.top = `${rect.bottom + 4}px`;
          popup.style.left = `${rect.left}px`;
        }

        root = createRoot(popup);
        root.render(
          <StoryMentionMenu
            items={props.items as StoryResult[]}
            command={(item) => { props.command(item); }}
            emptyLabel={emptyLabel}
          />,
        );
      },

      onUpdate(props) {
        const rect = props.clientRect?.();
        if (rect && popup) {
          popup.style.top = `${rect.bottom + 4}px`;
          popup.style.left = `${rect.left}px`;
        }
        root?.render(
          <StoryMentionMenu
            items={props.items as StoryResult[]}
            command={(item) => { props.command(item); }}
            emptyLabel={emptyLabel}
          />,
        );
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup?.remove(); popup = null; root?.unmount(); root = null;
          return true;
        }
        return false;
      },

      onExit() {
        popup?.remove(); popup = null; root?.unmount(); root = null;
      },
    }),

    command({ editor, range, props }) {
      const item = props as StoryResult;
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: 'text',
            marks: [{ type: 'link', attrs: { href: `entity:story:${item.id}` } }],
            text: item.title,
          },
          // 마크 밖 공백 — 삽입 직후 이어 타이핑하는 글자가 링크 mark를 안 물려받게(마크는
          // 이 공백 노드에 안 걸려 있으므로 커서가 여길 지나면 마크가 자연히 끊긴다).
          { type: 'text', text: ' ' },
        ])
        .run();
    },
  };
}

export interface StoryMentionOptions {
  projectId?: string;
  emptyLabel: string;
}

export const StoryMentionExtension = Extension.create<StoryMentionOptions>({
  name: 'storyMention',

  addOptions() {
    return { projectId: undefined, emptyLabel: '' };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('storyMentionSuggestion'),
        ...createStoryMentionSuggestion(this.options.projectId, this.options.emptyLabel),
      }),
    ];
  },
});
