// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import LinkExt from '@tiptap/extension-link';
import {
  createStoryMentionSuggestion, sanitizeLinkText, StoryMentionMenu, type StoryResult,
} from './story-mention';

// story #3866 AC2 — 검색(items)·삽입(command)·빈 상태·키보드 접근. wiki-link.tsx엔 전용
// 테스트가 없어(그라운딩 확認) reclaim-merged-worktrees.test.sh류 "합성 데이터로 실행 결과
// 고정" 원칙을 그대로 이 TipTap 확장에 적용한다 — attachment-upload.roundtrip.test.ts와
// 동일하게 global.fetch를 스텁해 실 네트워크 0.

describe('sanitizeLinkText — 이 팀 스토리 제목 관례([SID:NNNN] 등)가 markdownToHtml의 홈그로운 정규식을 안 깨게', () => {
  it('대괄호를 짝 맞는 괄호로 치환한다', () => {
    expect(sanitizeLinkText('[SID:3864] CI 인프라')).toBe('(SID:3864) CI 인프라');
  });
  it('대괄호가 없으면 그대로', () => {
    expect(sanitizeLinkText('가입 폼 단순화')).toBe('가입 폼 단순화');
  });
});

describe('createStoryMentionSuggestion — items(검색)', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      expect(u).toContain('/api/entities/search');
      expect(u).toContain('project_id=proj-1');
      expect(u).toContain('types=story');
      return {
        ok: true,
        status: 200,
        // Next.js 프록시 apiSuccess()가 FastAPI 원본 바디를 한 겹 더 감싼 실 응답 형상
        // (use-entity-picker.ts 문서화 — {data: {data, types}}).
        json: async () => ({
          data: {
            data: [
              { entity_type: 'story', entity_id: 's1', title: '가입 폼 단순화', status: null },
              { entity_type: 'story', entity_id: 's2', title: '결제 트랙', status: null },
            ],
            types: { story: { shown: 2, total: 2 } },
          },
          error: null,
          meta: null,
        }),
      } as Response;
    }) as unknown as typeof fetch;
  });

  it('project_id+types=story로 조회해 story만 {id,title}로 매핑한다', async () => {
    const suggestion = createStoryMentionSuggestion('proj-1', '일치하는 스토리가 없어요');
    const items = await suggestion.items!({ query: '가입', editor: {} as never });
    expect(items).toEqual([
      { id: 's1', title: '가입 폼 단순화' },
      { id: 's2', title: '결제 트랙' },
    ]);
  });

  it('projectId 없으면 fetch 자체를 안 하고 빈 배열', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const suggestion = createStoryMentionSuggestion(undefined, '없어요');
    const items = await suggestion.items!({ query: '', editor: {} as never });
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetch 실패(네트워크 예외)면 빈 배열(throw 0)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const suggestion = createStoryMentionSuggestion('proj-1', '없어요');
    const items = await suggestion.items!({ query: 'x', editor: {} as never });
    expect(items).toEqual([]);
  });
});

describe('createStoryMentionSuggestion — command(삽입)', () => {
  const ENTITY_HREF_RE = /^entity:[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const STORY_ID = '11111111-2222-3333-4444-555555555555';

  // doc-editor.tsx 실 설정과 동형(isAllowedUri 화이트리스트에 entity 스킴이 없으면 href가
  // 통째로 비는 걸 이 테스트가 처음 실측으로 잡았다 — 실 설정과 다른 Link면 「진짜로
  // 삽입되는가」를 테스트한 게 아니게 된다). id는 실제 uuid 형태로 — 검증 자체를 우회하는
  // 테스트 전용 구멍을 만들지 않는다.
  function makeEditor(content = '<p></p>') {
    return new Editor({
      extensions: [
        Document, Paragraph, Text,
        LinkExt.configure({
          protocols: [{ scheme: 'entity' }],
          isAllowedUri: (url: string, ctx: { defaultValidate: (u: string) => boolean }) => {
            if (/^entity:/.test(url)) return ENTITY_HREF_RE.test(url);
            return ctx.defaultValidate(url);
          },
        }),
      ],
      content,
    });
  }

  /** 빈 문단의 유일한 유효 내부 위치(문서 스키마: doc>paragraph, 빈 문단 진입점=1). */
  const START_RANGE = { from: 1, to: 1 };

  it('선택한 스토리를 entity:story: 앵커(Link mark)로 삽입한다 — 새 노드 타입 0', () => {
    const editor = makeEditor();
    const suggestion = createStoryMentionSuggestion('proj-1', '없어요');
    const item: StoryResult = { id: STORY_ID, title: '가입 폼 단순화' };
    suggestion.command!({ editor, range: START_RANGE, props: item } as never);
    const html = editor.getHTML();
    expect(html).toContain(`href="entity:story:${STORY_ID}"`);
    expect(html).toContain('가입 폼 단순화');
    editor.destroy();
  });

  it('삽입 뒤 이어 타이핑한 글자는 링크 mark를 안 물려받는다(트레일링 공백이 마크 밖)', () => {
    const editor = makeEditor();
    const suggestion = createStoryMentionSuggestion('proj-1', '없어요');
    const item: StoryResult = { id: STORY_ID, title: '가입 폼 단순화' };
    suggestion.command!({ editor, range: START_RANGE, props: item } as never);
    editor.commands.insertContent('이어쓰기');
    const html = editor.getHTML();
    // "이어쓰기"가 <a> 태그 밖(링크 텍스트 "가입 폼 단순화" 뒤, 마크 상속 없이)에 있어야 한다.
    expect(html).toMatch(/가입 폼 단순화<\/a>[^<]*이어쓰기/);
    editor.destroy();
  });

  it('제목의 대괄호는 sanitizeLinkText를 거쳐 삽입된다([SID:NNNN]류 안전)', () => {
    const editor = makeEditor();
    const suggestion = createStoryMentionSuggestion('proj-1', '없어요');
    const item: StoryResult = { id: STORY_ID, title: '[SID:3864] CI 인프라' };
    suggestion.command!({ editor, range: START_RANGE, props: item } as never);
    const html = editor.getHTML();
    expect(html).toContain('(SID:3864) CI 인프라');
    expect(html).not.toContain('[SID:3864]');
    editor.destroy();
  });
});

describe('StoryMentionMenu — 키보드 접근(↑↓ Enter)·빈 상태', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('빈 결과면 emptyLabel 1줄만(항목 0)', async () => {
    await act(async () => {
      root.render(<StoryMentionMenu items={[]} command={() => {}} emptyLabel="일치하는 스토리가 없어요" />);
    });
    expect(container.textContent).toBe('일치하는 스토리가 없어요');
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('항목이 있으면 버튼 목록으로 그리고 클릭 시 command가 그 항목으로 불린다', async () => {
    const items: StoryResult[] = [{ id: 's1', title: '가입 폼' }, { id: 's2', title: '결제 트랙' }];
    const command = vi.fn();
    await act(async () => {
      root.render(<StoryMentionMenu items={items} command={command} emptyLabel="없어요" />);
    });
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    await act(async () => { buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(command).toHaveBeenCalledWith(items[1]);
  });

  it('ArrowDown/ArrowUp으로 selectedIndex가 순환하고 Enter가 그 항목으로 command를 부른다', async () => {
    const items: StoryResult[] = [{ id: 's1', title: '가입 폼' }, { id: 's2', title: '결제 트랙' }, { id: 's3', title: '온보딩' }];
    const command = vi.fn();
    await act(async () => {
      root.render(<StoryMentionMenu items={items} command={command} emptyLabel="없어요" />);
    });
    // 기본 selectedIndex=0에서 ArrowDown 2번 → s3(index 2)로 이동.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(command).toHaveBeenCalledWith(items[2]);
  });

  it('ArrowUp이 0번째에서 마지막으로 순환한다', async () => {
    const items: StoryResult[] = [{ id: 's1', title: '가입 폼' }, { id: 's2', title: '결제 트랙' }];
    const command = vi.fn();
    await act(async () => {
      root.render(<StoryMentionMenu items={items} command={command} emptyLabel="없어요" />);
    });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(command).toHaveBeenCalledWith(items[1]); // 마지막(index 1)으로 순환.
  });
});
