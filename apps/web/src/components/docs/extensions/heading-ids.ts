/**
 * story #4339(유나 4708 · 수식 빈 칸) — 제목 앵커 id를 **ProseMirror가 그리게** 한다(노드 장식 decoration).
 *
 * 예전: doc-editor.tsx 효과가 편집기 DOM의 h1~h3에 `el.id = …`를 직접 썼다. ProseMirror의 DOMObserver는 자기가 그리지 않은 DOM 변경을
 * «사용자 편집»으로 보고 그 범위를 다시 읽는데(readDOMChange), 제목 바로 뒤가 수식 NodeView면 다시 읽은 수식 글이 빈 채로 문서에 들어가
 * — 마크다운 문서를 다시 열기만 해도 수식이 비고 자동 저장이 `data-latex=""`로 저장했다(실 브라우저 · DocEditor 실측 · 거래 추적).
 * id 계산은 목차(DocToc)와 같은 함수 하나(computeHeadingAnchors) — 목차 링크와 앵커가 어긋나지 않게.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { slugifyHeading } from '../doc-heading-utils';

export interface HeadingAnchor {
  pos: number;
  size: number;
  level: number;
  text: string;
  id: string;
}

/** 문서의 제목(글 있는 것 · 모든 수준 — 목차가 예전부터 세던 범위)마다 앵커 id — 같은 글이면 `-2`, `-3` 꼬리. */
export function computeHeadingAnchors(doc: PMNode): HeadingAnchor[] {
  const anchors: HeadingAnchor[] = [];
  const counts = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (!text) return true;
      const baseId = slugifyHeading(text);
      const seen = counts.get(baseId) ?? 0;
      counts.set(baseId, seen + 1);
      anchors.push({ pos, size: node.nodeSize, level: node.attrs.level as number, text, id: seen === 0 ? baseId : `${baseId}-${seen + 1}` });
    }
    return true;
  });
  return anchors;
}

const headingIdsKey = new PluginKey<DecorationSet>('headingIds');

function decorate(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeHeadingAnchors(doc).map((a) => Decoration.node(a.pos, a.pos + a.size, { id: a.id })));
}

export const HeadingIds = Extension.create({
  name: 'headingIds',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: headingIdsKey,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => headingIdsKey.getState(state),
        },
      }),
    ];
  },
});
