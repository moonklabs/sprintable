// @vitest-environment jsdom
//
// 4910 — 그림 위 우클릭 메뉴(산출물 상세, `layout="page"`): 머리 단추와 «같은 동작»(정본으로 제안 · 내보내기)만 — 새 동작 0, 우클릭에만 있는 동작 0.
// 폰(터치)에는 머리 단추가 그대로 남는다. 스토리 패널용 기본 배치(embedded)에는 이 메뉴가 없다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 안쪽 «이것을 가리키는 것들»이 backlinks를 받는다 — 빈 목록.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<React.ComponentProps<typeof ArtifactViewer>> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} {...props} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const rightClick = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60, button: 2 }));
});
const menuItems = () => [...document.body.querySelectorAll('[role="menu"] [role="menuitem"]')];
const trigger = () => container.querySelector('[data-testid="artifact-picture-menu-trigger"]')!;
const headButtonTexts = () => [...container.querySelectorAll('[data-slot="ds-page-head-actions"] button')].map((b) => b.textContent);

describe('그림 위 우클릭 메뉴 (layout="page")', () => {
  it('정본이 아닌 판을 볼 때: «정본으로 제안 · 내보내기» 둘뿐 — 머리 단추와 같은 이름', async () => {
    await mount({ onProposeCanonical: () => undefined });
    await rightClick(trigger());
    const labels = menuItems().map((i) => i.textContent);
    expect(labels).toEqual(['정본으로 제안', '내보내기']);
    for (const label of labels) expect(headButtonTexts()).toContain(label); // 우클릭 전용 동작 0
  });

  it('«정본으로 제안»은 머리 단추와 같은 일: 보는 판 번호로 onProposeCanonical을 한 번 부른다', async () => {
    const propose = vi.fn();
    await mount({ onProposeCanonical: propose });
    await rightClick(trigger());
    await act(async () => { menuItems()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith(MOCK_ARTIFACT.current_version);
  });

  it('«내보내기»는 머리 단추와 같은 내보내기 창을 연다', async () => {
    await mount({ onProposeCanonical: () => undefined });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await rightClick(trigger());
    await act(async () => { menuItems()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain('내보내기');
  });

  it('제안할 수 없는 때(이미 정본 · 제안 대기 중 · 제안 동작 없음)에는 «내보내기»만 — 머리에도 제안 단추가 없다', async () => {
    const cases: Array<Partial<React.ComponentProps<typeof ArtifactViewer>>> = [
      { artifact: { ...MOCK_ARTIFACT, anchor_version: MOCK_ARTIFACT.current_version }, onProposeCanonical: () => undefined },
      { onProposeCanonical: () => undefined, pendingCanonicalizeVersion: MOCK_ARTIFACT.current_version },
      {},
    ];
    for (const props of cases) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await mount(props);
      await rightClick(trigger());
      expect(menuItems().map((i) => i.textContent)).toEqual(['내보내기']);
      expect(headButtonTexts()).not.toContain('정본으로 제안');
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    }
  });

  it('스토리 패널용 기본 배치(embedded)에는 이 메뉴가 없다 — 우클릭해도 메뉴 0', async () => {
    await mount({ layout: 'embedded', onProposeCanonical: () => undefined });
    expect(container.querySelector('[data-testid="artifact-picture-menu-trigger"]')).toBeNull();
    await rightClick(container.querySelector('[data-stage-region]')!);
    expect(menuItems()).toHaveLength(0);
  });
});
