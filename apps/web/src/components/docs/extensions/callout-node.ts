import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: () => ReturnType;
      toggleCallout: () => ReturnType;
    };
  }
}

export const CalloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [
      { tag: 'div[data-callout]' },
      { tag: 'div.callout' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': '',
        // story 4831: 인라인 style(리터럴 hex · px)을 바탕 토큰 클래스로. 에디터 안은 globals.css의 `.tiptap-content … div[data-callout]` 규칙이 같은 토큰으로 같은 모양을 준다.
        class: 'callout my-2 rounded-r-md border-l-[3px] border-proof-amber bg-proof-amber-soft px-4 py-3',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },
});
