// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ActivationChecklistBanner } from './activation-checklist-banner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETE_KEY = 'sprintable_activation_checklist_complete';
const COLLAPSE_KEY = 'sprintable_activation_checklist_collapsed';

// story #2059(kanban-board.test.tsx)/chat-input.test.tsx와 동일 패턴 — jsdom/Node의 네이티브
// local/sessionStorage가 이 실행 환경에서 온전치 않아(--localstorage-file 미설정 시 .clear()
// 등이 없는 스텁으로 대체됨) Map 기반 페이크로 통째로 교체한다.
let localStore: Map<string, string>;
let sessionStore: Map<string, string>;
function stubStorages() {
  localStore = new Map<string, string>();
  sessionStore = new Map<string, string>();
  const make = (store: Map<string, string>) => ({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.stubGlobal('localStorage', make(localStore));
  vi.stubGlobal('sessionStorage', make(sessionStore));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubStorages();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubChecklist(data: {
  steps: Record<string, boolean>;
  completed: number;
  total: number;
  all_complete: boolean;
}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));
}

const PARTIAL = {
  steps: { signed_up: true, email_verified: false, org_created: true, agent_connected: false, first_roundtrip: false },
  completed: 2,
  total: 5,
  all_complete: false,
};

const COMPLETE = {
  steps: { signed_up: true, email_verified: true, org_created: true, agent_connected: true, first_roundtrip: true },
  completed: 5,
  total: 5,
  all_complete: true,
};

describe('ActivationChecklistBanner — 미완주 렌더 (story #3159)', () => {
  it('미완주면 진행률·단계 목록이 한국어로 렌더된다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입을 마무리해 볼까요?');
    expect(container.textContent).toContain('2/5단계 완료');
    expect(container.textContent).toContain('이메일 인증하기');
  });
});

describe('ActivationChecklistBanner — 완주 시 완전 소멸 (PO 지시)', () => {
  it('all_complete=true면 아무것도 렌더하지 않고 localStorage에 영구 기록한다', async () => {
    stubChecklist(COMPLETE);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toBe('');
    expect(window.localStorage.getItem(COMPLETE_KEY)).toBe('1');
  });

  it('localStorage에 완주 플래그가 있으면 fetch 자체를 건너뛴다', async () => {
    window.localStorage.setItem(COMPLETE_KEY, '1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});

describe('ActivationChecklistBanner — 접기(collapse), 완전 dismiss는 없음 (PO 정정)', () => {
  it('접기를 누르면 체크리스트는 숨고 진행률 칩은 남는다', async () => {
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('이메일 인증하기');

    const collapseBtn = container.querySelector('button[aria-label="접기"]') as HTMLButtonElement;
    expect(collapseBtn).not.toBeNull();
    await act(async () => { collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('이메일 인증하기');
    expect(container.textContent).toContain('가입 완료 2/5');
    expect(window.sessionStorage.getItem(COLLAPSE_KEY)).toBe('1');
  });

  it('접힌 칩을 다시 누르면 펼쳐진다', async () => {
    window.sessionStorage.setItem(COLLAPSE_KEY, '1');
    stubChecklist(PARTIAL);
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toContain('가입 완료 2/5');
    expect(container.textContent).not.toContain('이메일 인증하기');

    const chip = container.querySelector('button[aria-label="펼치기"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    await act(async () => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain('이메일 인증하기');
  });
});

describe('ActivationChecklistBanner — 조회 실패 시 미노출', () => {
  it('fetch 실패하면 아무것도 렌더하지 않는다(에러 표면 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(wrap(<ActivationChecklistBanner />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});
