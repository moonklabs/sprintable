// @vitest-environment jsdom
//
// story #3274(지원v1·후속) — activation-checklist-banner.tsx에서 뽑아낸 공유 hook. 핵심
// 계약(AC①) — 배너와 support-widget-launcher.tsx 둘 다 이 훅을 부르는데, 둘이 같은 렌더
// 사이클에 마운트돼도 실 fetch는 세션당 1회로 수렴해야 한다("배너와 단일 fetch·COMPLETE_KEY
// 공유"). 이 파일은 그 dedup 자체와, 기존 banner 테스트가 이미 커버하는 skip/기록 계약을
// 훅 레벨에서 직접 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { _resetActivationStatusCacheForTests, useActivationStatus } from './use-activation-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETE_KEY = 'sprintable_activation_checklist_complete';

let localStore: Map<string, string>;
function stubLocalStorage() {
  localStore = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => { localStore.set(k, v); },
    removeItem: (k: string) => { localStore.delete(k); },
    clear: () => { localStore.clear(); },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLocalStorage();
  _resetActivationStatusCacheForTests();
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

function stubChecklistFetch(data: object) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ data }) }));
}

const PARTIAL = {
  steps: { signed_up: true, email_verified: false, org_created: true, agent_connected: false, first_roundtrip: false },
  completed: 2,
  total: 5,
  all_complete: false,
  first_instruction_conversation_id: null,
};

function Probe({ testid }: { testid: string }) {
  const { allComplete } = useActivationStatus();
  return <span data-testid={testid}>{String(allComplete)}</span>;
}

describe('useActivationStatus — story #3274 AC① 단일 fetch 공유', () => {
  it('두 소비처(배너 형태·런처 형태)가 같은 렌더에 동시 마운트돼도 실 fetch는 1회만 나간다', async () => {
    const fetchSpy = stubChecklistFetch(PARTIAL);
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => {
      root.render(
        <>
          <Probe testid="banner" />
          <Probe testid="launcher" />
        </>,
      );
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="banner"]')!.textContent).toBe('false');
    expect(container.querySelector('[data-testid="launcher"]')!.textContent).toBe('false');
  });

  it('localStorage에 완주 플래그가 있으면 fetch 자체를 건너뛰고 allComplete=true를 즉시 반환한다', async () => {
    window.localStorage.setItem(COMPLETE_KEY, '1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(<Probe testid="probe" />); });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe('true');
  });

  it('all_complete=true 응답을 받으면 localStorage에 영구 기록한다(다음 세션 재조회 방지)', async () => {
    vi.stubGlobal('fetch', stubChecklistFetch({ ...PARTIAL, all_complete: true, completed: 5 }));
    await act(async () => { root.render(<Probe testid="probe" />); });
    await flush();
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe('true');
    expect(window.localStorage.getItem(COMPLETE_KEY)).toBe('1');
  });

  it('fetch 실패는 조용히 삼키고 allComplete=false로 남는다(에러 표면 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(<Probe testid="probe" />); });
    await flush();
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe('false');
  });
});

function SeedProbe({ seed, verify }: { seed?: boolean; verify?: boolean }) {
  const { allComplete } = useActivationStatus(seed, { verifyInBackground: verify });
  return <span data-testid="seed">{String(allComplete)}</span>;
}

describe('useActivationStatus — 표시용 힌트 시드(story #4219 F1 · 힌트는 조언일 뿐)', () => {
  it('서버 확인 시드(true) → 조회 0 · 완주', async () => {
    const fetchSpy = stubChecklistFetch(PARTIAL);
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(<SeedProbe seed />); });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="seed"]')!.textContent).toBe('true');
  });

  it('⭐힌트 시드(true) + 재확인 → 처음엔 완주로(스켈레톤 없음) · 한 번 조회 · 완주가 되돌아갔으면 늦게라도 미완주로', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchSpy = vi.fn(async () => { await gate; return { ok: true, json: async () => ({ data: PARTIAL }) }; });
    vi.stubGlobal('fetch', fetchSpy);
    await act(async () => { root.render(<SeedProbe seed verify />); });
    // 재확인 응답 전 — 완주로 보여 둔다(스켈레톤·배너 0).
    expect(container.querySelector('[data-testid="seed"]')!.textContent).toBe('true');
    release();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="seed"]')!.textContent).toBe('false');
  });

  it('힌트 시드 재확인에서 미완주면 로컬 완주 플래그도 지운다(다음 세션에 배너가 영영 숨지 않게)', async () => {
    window.localStorage.setItem(COMPLETE_KEY, '1');
    vi.stubGlobal('fetch', stubChecklistFetch(PARTIAL));
    await act(async () => { root.render(<SeedProbe seed verify />); });
    await flush();
    expect(window.localStorage.getItem(COMPLETE_KEY)).toBeNull();
  });
});
