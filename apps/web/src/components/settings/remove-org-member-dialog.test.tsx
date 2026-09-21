// @vitest-environment jsdom
//
// story #4120(PO 실측, 2026-09-21) — removeMemberConfirmSuffix의 「을(를)」 고정 조사(라벨
// 자체에 {name} 자리조차 없어 항상 raw로 새던 자리)를 pickEulReulJosa로 고친다. 이전엔
// literal 공백까지 있어 "{name} 을(를) 조직에서"로 이중으로 샜다 — 그 공백도 함께 뗀다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RemoveOrgMemberDialog } from './remove-org-member-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function renderDialog(name: string) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <RemoveOrgMemberDialog
          open
          member={{ id: 'm1', name }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </NextIntlClientProvider>,
    );
  });
}

describe('RemoveOrgMemberDialog — removeMemberConfirmSuffix 조사(story #4120)', () => {
  it('받침 없는 이름 → «를», 이름 뒤 공백 없이 바로 붙는다', () => {
    renderDialog('디디');
    expect(document.body.textContent).toContain('디디를 조직에서 제거해요.');
    expect(document.body.textContent).not.toContain('을(를)');
    expect(document.body.textContent).not.toContain('디디 를');
  });

  it('받침 있는 이름 → «을», 이름 뒤 공백 없이 바로 붙는다', () => {
    renderDialog('강남');
    expect(document.body.textContent).toContain('강남을 조직에서 제거해요.');
    expect(document.body.textContent).not.toContain('을(를)');
  });
});
