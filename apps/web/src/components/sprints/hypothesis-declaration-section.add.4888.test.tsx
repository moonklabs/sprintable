// @vitest-environment jsdom
// story #4888(보드 머리 PR에 얹은 한 줄) — «+ 가설 추가»가 ds Button으로 바뀌었어도 누르면 선언 카드가 하나 늘어난다(동작 그대로). 정적 마크업 시험은 누름을 못 보므로 DOM으로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HypothesisDeclarationSection } from './hypothesis-declaration-section';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('HypothesisDeclarationSection — «+ 가설 추가»(story #4888)', () => {
  it('⭐누르면 빈 선언 카드가 하나 더해진 목록으로 onChange가 불린다(기존 카드는 그대로)', async () => {
    const onChange = vi.fn();
    const existing: HypothesisDeclarationValue = { ...EMPTY_DECLARATION, statement: '이미 쓴 가설' };
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={[existing]} onChange={onChange} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const add = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(koMessages.sprints.declareAddCta)) as HTMLButtonElement;
    expect(add.getAttribute('data-slot')).toBe('ds-button');
    await act(async () => { add.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as HypothesisDeclarationValue[];
    expect(next).toHaveLength(2);
    expect(next[0]!.statement).toBe('이미 쓴 가설');
    expect(next[1]).toEqual(EMPTY_DECLARATION);
  });
});
