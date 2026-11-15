// UI-3(a9d56577) — ds Field 회귀가드: 이름 연결 · 오류(아이콘 + 글 + alert) · 도움말 · aria-describedby.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
});
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
import { Field } from './field';
import { Input } from './input';

const q = (s: string) => container.querySelector(s) as HTMLElement | null;

function F({ error, hint }: { error?: string; hint?: string }) {
  return <Field label="이메일" error={error} hint={hint}>{(c) => <Input {...c} />}</Field>;
}

describe('ds Field', () => {
  it('⭐보이는 이름이 칸에 label for로 이어진다', async () => {
    await render(<F />);
    const label = q('label')!;
    const el = q('input')!;
    expect(label.textContent).toBe('이메일');
    expect(label.getAttribute('for')).toBe(el.id);
    expect(el.getAttribute('aria-invalid')).toBeNull();
    expect(el.getAttribute('aria-describedby')).toBeNull();
  });

  it('⭐오류가 있으면 칸이 aria-invalid, 오류 글이 보이고(role=alert · error 아이콘) aria-describedby로 이어진다', async () => {
    await render(<F error="이메일 형식이 아니에요" hint="회사 메일" />);
    const el = q('input')!;
    expect(el.getAttribute('aria-invalid')).toBe('true');
    const note = document.getElementById(el.getAttribute('aria-describedby')!)!;
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toContain('이메일 형식이 아니에요');
    expect(note.querySelector('[data-icon="error"]')).not.toBeNull();
    // 오류가 있으면 도움말은 오류가 대신한다
    expect(container.textContent).not.toContain('회사 메일');
  });

  it('오류가 없고 도움말만 있으면 도움말이 describedby로 이어진다(alert 아님)', async () => {
    await render(<F hint="회사 메일" />);
    const el = q('input')!;
    const note = document.getElementById(el.getAttribute('aria-describedby')!)!;
    expect(note.textContent).toBe('회사 메일');
    expect(note.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-invalid')).toBeNull();
  });

  it('칸이 둘이면 id가 서로 다르다', async () => {
    await render(<><F /><F /></>);
    const ids = [...container.querySelectorAll('input')].map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});
