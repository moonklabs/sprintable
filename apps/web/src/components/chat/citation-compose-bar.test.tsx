// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CitationComposeBar } from './citation-compose-bar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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

const NOOP = () => {};

describe('CitationComposeBar — story #2265(C-7) 저장 조각', () => {
  it('anchored 모드에서는 안내 문구만 뜨고 저장 버튼은 없다', async () => {
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="anchored" selectedCount={0} saveState="idle" onCancel={NOOP} onSave={NOOP} />));
    });
    expect(container.textContent).toContain('여기부터 인용');
    expect(container.textContent).not.toContain('스토리에 저장');
  });

  it('confirming 모드에서는 선택 개수와 저장 버튼이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={3} saveState="idle" onCancel={NOOP} onSave={NOOP} />));
    });
    expect(container.textContent).toContain('3개 메시지 선택됨');
    expect(container.textContent).toContain('스토리에 저장');
  });

  it('저장 버튼 클릭 시 onSave가 불린다', async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={1} saveState="idle" onCancel={NOOP} onSave={onSave} />));
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '스토리에 저장');
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('취소 버튼 클릭 시 onCancel이 불린다(어느 모드든)', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="anchored" selectedCount={0} saveState="idle" onCancel={onCancel} onSave={NOOP} />));
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '취소');
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('saveState="saving"이면 저장/취소 버튼이 비활성화된다(중복 제출 방지)', async () => {
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={2} saveState="saving" onCancel={NOOP} onSave={NOOP} />));
    });
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('저장 중'));
    expect(saveBtn).not.toBeUndefined();
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('saveState="saved"이면 저장됨 문구만 뜨고 취소/저장 버튼은 사라진다', async () => {
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={2} saveState="saved" onCancel={NOOP} onSave={NOOP} />));
    });
    expect(container.textContent).toContain('저장됨');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    ['error_permission', '권한이 없습니다'],
    ['error_invalid', '처리할 수 없습니다'],
    ['error_network', '네트워크를 확인'],
  ] as const)('saveState=%s이면 그 원인에 맞는 문구가 뜨고 저장 버튼으로 재시도할 수 있다(중복 idle 복귀 없음)', async (state, expectedSubstring) => {
    await act(async () => {
      root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={2} saveState={state} onCancel={NOOP} onSave={NOOP} />));
    });
    expect(container.textContent).toContain('저장 실패');
    expect(container.textContent).toContain(expectedSubstring);
    expect(container.textContent).toContain('스토리에 저장'); // 재시도 가능 — 멈춰 있지 않다.
  });

  it('셋(권한·범위·네트워크) 실패 문구는 서로 다르다 — 같은 말로 뭉치지 않는다(PO 지적 2026-07-29)', async () => {
    const texts = new Set<string>();
    for (const state of ['error_permission', 'error_invalid', 'error_network'] as const) {
      await act(async () => {
        root.render(wrap(<CitationComposeBar mode="confirming" selectedCount={1} saveState={state} onCancel={NOOP} onSave={NOOP} />));
      });
      texts.add(container.textContent ?? '');
    }
    expect(texts.size).toBe(3);
  });
});
