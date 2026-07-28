// @vitest-environment jsdom
//
// story #2264(C-6) — EntityAwareTextarea가 참조 코어(chat-input-entity-tokens.ts +
// use-entity-picker.ts)를 그대로 재사용해 `#` 피커가 실제로 동작하는지 확인한다. 채팅
// (chat-input.test.tsx)과 같은 검색 fetch·토큰조립을 story 본문 자리에서도 그대로 검증.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EntityAwareTextarea } from './entity-aware-textarea';

// 실제 controlled input처럼 동작해야 e.target.value/selectionStart가 이어지는 입력에서
// 최신값을 반영한다 — 바깥 let 변수만 갱신하면 리렌더가 없어 DOM value가 안 바뀐다.
function ControlledHarness({ initial, projectId, onValueChange }: { initial: string; projectId?: string; onValueChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <EntityAwareTextarea
      value={value}
      onChange={(v) => { setValue(v); onValueChange(v); }}
      projectId={projectId}
    />
  );
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
});

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('EntityAwareTextarea — story #2264', () => {
  it('projectId 없이는 `#`을 쳐도 피커가 안 뜬다(검색 스코프 없이 조회 안 함)', async () => {
    let value = '';
    await act(async () => {
      root.render(<EntityAwareTextarea value={value} onChange={(v) => { value = v; }} />);
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '#');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('projectId가 있으면 `#` 후보 검색이 뜨고 선택하면 escape된 토큰이 삽입된다(채팅 applyEntity와 동일 규칙)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/entities/search')) {
        return new Response(JSON.stringify({
          data: [{ entity_type: 'story', entity_id: '11111111-1111-1111-1111-111111111111', title: '[TAG] 위험한 제목]', status: null }],
        }));
      }
      return new Response(JSON.stringify({ data: [] }));
    }));

    let value = '';
    await act(async () => {
      root.render(<ControlledHarness initial="" projectId="p1" onValueChange={(v) => { value = v; }} />);
    });
    const el = textarea();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, '#');
      el.selectionStart = 1;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });

    const option = container.querySelector('[role="option"]') as HTMLButtonElement;
    expect(option).not.toBeNull();
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // ⛔title에 `]`가 있어도(팀 [TAG] 관례) 링크 구문이 안 끊긴다 — #2292 escape 규칙 그대로.
    expect(value).toContain('\\]');
    expect(value).toContain('(entity:story:11111111-1111-1111-1111-111111111111)');
  });
});
