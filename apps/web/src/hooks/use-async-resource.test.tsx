// @vitest-environment jsdom
//
// story #4066(사전조사 doc 193b2797) — useAsyncResource/useAsyncResourceBatch 스켈레톤.
// use-material-lineage.test.tsx/use-hook-performances.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAsyncResource, useAsyncResourceBatch } from './use-async-resource';

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

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

// renderToStaticMarkup은 effect를 안 돌려 useState 초기값(=실 첫 페인트가 낼 값) 그대로를
// 관측한다 — 단, JSX 텍스트 노드의 `"`를 `&quot;`로 이스케이프하므로 JSON.parse 前에 되돌린다.
function dumpFromStaticMarkup(html: string) {
  const raw = html.match(/data-testid="dump">(.*?)<\/div>/)![1];
  return JSON.parse(raw.replace(/&quot;/g, '"'));
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

describe('useAsyncResource', () => {
  function Harness({ resourceKey, fetcher }: { resourceKey: string | null; fetcher: (k: string) => Promise<string> }) {
    const { data, loading, loadFailed, refresh } = useAsyncResource<string, string | null>(
      resourceKey, null, async (k, signal) => { if (signal.cancelled()) throw new Error('should not reach'); return fetcher(k); }, [],
    );
    return (
      <>
        <button data-testid="refresh" onClick={refresh}>refresh</button>
        <div data-testid="dump">{JSON.stringify({ data, loading, loadFailed })}</div>
      </>
    );
  }

  it('key가 null이면 fetch 자체를 안 태우고 initial을 낸다', async () => {
    const fetcher = vi.fn();
    await act(async () => { root.render(<Harness resourceKey={null} fetcher={fetcher} />); });
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(dump()).toEqual({ data: null, loading: false, loadFailed: false });
  });

  it('key가 있으면 fetcher를 불러 성공 시 data를 채운다', async () => {
    const fetcher = vi.fn(async (k: string) => `resolved:${k}`);
    await act(async () => { root.render(<Harness resourceKey="a" fetcher={fetcher} />); });
    await flush();
    expect(fetcher).toHaveBeenCalledWith('a');
    expect(dump()).toEqual({ data: 'resolved:a', loading: false, loadFailed: false });
  });

  it('fetcher가 throw하면 loadFailed=true·data는 initial로 되돌아간다', async () => {
    const fetcher = vi.fn(async () => { throw new Error('boom'); });
    await act(async () => { root.render(<Harness resourceKey="a" fetcher={fetcher} />); });
    await flush();
    expect(dump()).toEqual({ data: null, loading: false, loadFailed: true });
  });

  // story #4066 핵심 — 이 헬퍼가 없애려는 버그 클래스 자체를 pin. 스킵 분기와 fetch 분기가
  // 같은 종료점을 공유해서, key가 값→null로 바뀌는 순간(fetch 미해결 상태라도) loading이
  // 반드시 false로 풀려야 한다.
  it('fetch 진행 중 key가 null로 바뀌면 loading이 고착되지 않는다(핵심 회귀 클래스)', async () => {
    let resolveFetch: ((v: string) => void) | null = null;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => { resolveFetch = resolve; }));

    function Switcher() {
      const [key, setKey] = useState<string | null>('a');
      return (
        <>
          <button data-testid="clear" onClick={() => setKey(null)}>clear</button>
          <Harness resourceKey={key} fetcher={fetcher} />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump().loading).toBe(true);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(dump().loading).toBe(false);
    expect(dump().data).toBeNull();

    // 원래 in-flight였던 fetch가 뒤늦게 resolve돼도(취소된 effect) 재고착 안 한다.
    await act(async () => { resolveFetch?.('late'); });
    await flush();
    expect(dump().loading).toBe(false);
    expect(dump().data).toBeNull();
  });

  it('key가 바뀌면 새로 fetch한다(이전 결과로 안 덮임)', async () => {
    const fetcher = vi.fn(async (k: string) => `v:${k}`);
    function Switcher() {
      const [key, setKey] = useState('a');
      return (
        <>
          <button data-testid="switch" onClick={() => setKey('b')}>switch</button>
          <Harness resourceKey={key} fetcher={fetcher} />
        </>
      );
    }
    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump().data).toBe('v:a');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();
    expect(dump().data).toBe('v:b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refresh()는 같은 key로 강제 재조회한다', async () => {
    let call = 0;
    const fetcher = vi.fn(async () => { call += 1; return `call:${call}`; });
    await act(async () => { root.render(<Harness resourceKey="a" fetcher={fetcher} />); });
    await flush();
    expect(dump().data).toBe('call:1');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!.click(); });
    await flush();
    expect(dump().data).toBe('call:2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('먼저 시작된 fetch가 늦게 끝나도 나중 key의 결과를 덮어쓰지 않는다(경쟁 취소)', async () => {
    const resolvers = new Map<string, (v: string) => void>();
    const fetcher = vi.fn((k: string) => new Promise<string>((resolve) => { resolvers.set(k, resolve); }));

    function Switcher() {
      const [key, setKey] = useState('a');
      return (
        <>
          <button data-testid="switch" onClick={() => setKey('b')}>switch</button>
          <Harness resourceKey={key} fetcher={fetcher} />
        </>
      );
    }
    await act(async () => { root.render(<Switcher />); });
    await flush();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();

    // b가 먼저 resolve, 그 다음 a(늦게 시작했지만 더 늦게 끝난 구 요청)가 resolve돼도
    // 최종 data는 b여야 한다 — a는 cancelled라 반영 안 됨.
    await act(async () => { resolvers.get('b')?.('resolved:b'); });
    await flush();
    await act(async () => { resolvers.get('a')?.('resolved:a'); });
    await flush();
    expect(dump().data).toBe('resolved:b');
  });

  // story #4071 qa:changes(카디르, 2026-09-19, #4445 재작업 계기) — 기본값(옵션 미지정)은
  // 실패 시 data를 initial로 되돌린다(기존 동작 그대로 — #4444/#4446류 원본도 실패 시
  // 리셋이었으므로 회귀 아님).
  it('keepPreviousDataOnError 미지정(기본값)이면 실패 시 data가 initial로 되돌아간다', async () => {
    function DefaultHarness({ resourceKey, fetcher }: { resourceKey: string | null; fetcher: (k: string) => Promise<string> }) {
      const { data, loading, loadFailed } = useAsyncResource<string, string | null>(resourceKey, null, fetcher, []);
      return <div data-testid="dump">{JSON.stringify({ data, loading, loadFailed })}</div>;
    }
    function dump2() { return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!); }

    let call = 0;
    const fetcher = vi.fn(async () => { call += 1; if (call === 1) return 'first-success'; throw new Error('boom'); });
    function Switcher() {
      const [k, setK] = useState('a');
      return (
        <>
          <button data-testid="refresh" onClick={() => setK('b')}>refresh</button>
          <DefaultHarness resourceKey={k} fetcher={fetcher} />
        </>
      );
    }
    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump2().data).toBe('first-success');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!.click(); });
    await flush();
    expect(dump2()).toEqual({ data: null, loading: false, loadFailed: true });
  });

  // story #4071 qa:changes 핵심 — keepPreviousDataOnError:true면 재조회 실패 후에도
  // 마지막 성공 데이터가 그대로 남는다(use-channel-post-calendar-data.ts가 요구하는
  // "이전 데이터 유지 + error만 세움" 원본 계약을 이 옵션으로 복원).
  it('keepPreviousDataOnError:true면 재조회가 실패해도 마지막 성공 데이터를 유지한다(핵심 회귀)', async () => {
    function KeepHarness({ resourceKey, fetcher }: { resourceKey: string | null; fetcher: (k: string) => Promise<string> }) {
      const { data, loading, loadFailed } = useAsyncResource<string, string | null>(
        resourceKey, null, fetcher, [], { keepPreviousDataOnError: true },
      );
      return <div data-testid="dump">{JSON.stringify({ data, loading, loadFailed })}</div>;
    }
    function dump3() { return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!); }

    let call = 0;
    const fetcher = vi.fn(async () => { call += 1; if (call === 1) return 'first-success'; throw new Error('boom'); });
    function Switcher() {
      const [k, setK] = useState('a');
      return (
        <>
          <button data-testid="refresh" onClick={() => setK('b')}>refresh</button>
          <KeepHarness resourceKey={k} fetcher={fetcher} />
        </>
      );
    }
    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump3().data).toBe('first-success');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!.click(); });
    await flush();
    // data는 그대로, loadFailed만 true — 이전 성공 데이터가 실패 화면으로 안 지워진다.
    expect(dump3()).toEqual({ data: 'first-success', loading: false, loadFailed: true });
  });

  // story #4071 qa:changes(유나 design, 2026-09-19, #4445 재작업 계기, 마운트 flash) —
  // act() 기반 렌더는 effect의 동기 부분(setLoading(true))까지 act()가 자체적으로
  // 플러시해버려 "첫 페인트" 순간을 관측 못 한다(실 브라우저는 effect가 paint 後 실행돼
  // 그 사이 한 프레임이 보인다). renderToStaticMarkup은 effect를 아예 안 돌리므로
  // useState 초기값 그 자체(=실제 첫 페인트가 낼 값)를 정확히 관측한다.
  it('initialLoading 미지정(기본값)이면 첫 페인트에서 loading이 false다', () => {
    function Harness() {
      const { loading } = useAsyncResource<string, null>('a', null, async () => null, []);
      return <div data-testid="dump">{JSON.stringify({ loading })}</div>;
    }
    const html = renderToStaticMarkup(<Harness />);
    expect(dumpFromStaticMarkup(html)).toEqual({ loading: false });
  });

  // 핵심 회귀 — initialLoading:true면 key가 있을 때 첫 페인트부터 이미 loading:true다
  // (빈 그리드/EmptyState가 한 프레임도 안 보인다).
  it('initialLoading:true면 key가 있을 때 첫 페인트부터 이미 loading:true다(마운트 flash 방지, 핵심 회귀)', () => {
    function Harness({ resourceKey }: { resourceKey: string | null }) {
      const { loading } = useAsyncResource<string, null>(resourceKey, null, async () => null, [], { initialLoading: true });
      return <div data-testid="dump">{JSON.stringify({ loading })}</div>;
    }
    const htmlWithKey = renderToStaticMarkup(<Harness resourceKey="a" />);
    expect(dumpFromStaticMarkup(htmlWithKey)).toEqual({ loading: true });

    // 원본(use-channel-post-calendar-data.ts 구판)의 `useState(true)`도 orgId 값과 무관한
    // 무조건 초기화였다 — key 유무를 안 가린다(effect의 skip 분기가 뒤이어 false로
    // 되돌릴 뿐). initialLoading은 그 원본 동작을 그대로 재현하는 옵션이라 key=null이어도
    // 마찬가지로 true — "더 똑똑하게" 스킵을 미리 아는 신규 계약을 만들지 않는다.
    const htmlNoKey = renderToStaticMarkup(<Harness resourceKey={null} />);
    expect(dumpFromStaticMarkup(htmlNoKey)).toEqual({ loading: true });
  });
});

describe('useAsyncResourceBatch', () => {
  function Harness({ keys, fetchOne }: { keys: string[]; fetchOne: (k: string) => Promise<string | null> }) {
    const { itemsByKey, loading, loadFailed } = useAsyncResourceBatch(keys, fetchOne);
    return <div data-testid="dump">{JSON.stringify({ keys: Object.keys(itemsByKey), loading, loadFailed })}</div>;
  }

  it('keys가 빈 배열이면 fetchOne을 안 부른다', async () => {
    const fetchOne = vi.fn();
    await act(async () => { root.render(<Harness keys={[]} fetchOne={fetchOne} />); });
    await flush();
    expect(fetchOne).not.toHaveBeenCalled();
    expect(dump()).toEqual({ keys: [], loading: false, loadFailed: false });
  });

  it('각 key를 병렬 호출하고 맵으로 모은다', async () => {
    const fetchOne = vi.fn(async (k: string) => `v:${k}`);
    await act(async () => { root.render(<Harness keys={['a', 'b']} fetchOne={fetchOne} />); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(dump()).toEqual({ keys: ['a', 'b'], loading: false, loadFailed: false });
  });

  it('일부만 실패하면 그 key만 맵에서 빠진다 — 전부 실패해야 loadFailed', async () => {
    const fetchOne = vi.fn(async (k: string) => (k === 'bad' ? null : `v:${k}`));
    await act(async () => { root.render(<Harness keys={['a', 'bad']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: ['a'], loading: false, loadFailed: false });
  });

  it('전부 실패하면 loadFailed=true', async () => {
    const fetchOne = vi.fn(async () => null);
    await act(async () => { root.render(<Harness keys={['a']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: [], loading: false, loadFailed: true });
  });

  it('같은 key 집합이 순서만 바뀌면 재요청 안 한다(정규화된 depsKey)', async () => {
    const fetchOne = vi.fn(async (k: string) => `v:${k}`);
    function Reorderer() {
      const [order, setOrder] = useState<'ab' | 'ba'>('ab');
      const keys = order === 'ab' ? ['a', 'b'] : ['b', 'a'];
      return (
        <>
          <button data-testid="reorder" onClick={() => setOrder('ba')}>reorder</button>
          <Harness keys={keys} fetchOne={fetchOne} />
        </>
      );
    }
    await act(async () => { root.render(<Reorderer />); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(2);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="reorder"]')!.click(); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });

  // story #4066 핵심 — 스킵 분기(keys→[])도 같은 종료점에서 loading=false로 끝나야 한다.
  it('fetch 진행 중 keys가 빈 배열로 바뀌면 loading이 고착되지 않는다(핵심 회귀 클래스)', async () => {
    let resolveFetch: ((v: string) => void) | null = null;
    const fetchOne = vi.fn(() => new Promise<string>((resolve) => { resolveFetch = resolve; }));

    function Clearer() {
      const [keys, setKeys] = useState<string[]>(['a']);
      return (
        <>
          <button data-testid="clear" onClick={() => setKeys([])}>clear</button>
          <Harness keys={keys} fetchOne={fetchOne} />
        </>
      );
    }
    await act(async () => { root.render(<Clearer />); });
    await flush();
    expect(dump().loading).toBe(true);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(dump().loading).toBe(false);

    await act(async () => { resolveFetch?.('late'); });
    await flush();
    expect(dump().loading).toBe(false);
  });

  // story #4436 qa:changes round-2 교훈 — key에 공백이 섞여도(임의 문자열 계약) 오분할되지
  // 않아야 한다(JSON.stringify 기반 depsKey pin).
  it('key에 공백이 섞여 있어도 오분할되지 않고 딱 그 key 하나로 처리한다', async () => {
    const fetchOne = vi.fn(async (k: string) => `v:${k}`);
    await act(async () => { root.render(<Harness keys={['hook a']} fetchOne={fetchOne} />); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledWith('hook a');
    expect(dump().keys).toEqual(['hook a']);
  });

  it('서로 다른 key 집합이 공백 join 시 우연히 같은 문자열을 내도 depsKey가 다르게 구분된다', async () => {
    const fetchOne = vi.fn(async (k: string) => `v:${k}`);
    function Switcher() {
      const [which, setWhich] = useState<'first' | 'second'>('first');
      const keys = which === 'first' ? ['a b', 'c'] : ['a', 'b c'];
      return (
        <>
          <button data-testid="switch" onClick={() => setWhich('second')}>switch</button>
          <Harness keys={keys} fetchOne={fetchOne} />
        </>
      );
    }
    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(2);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();
    expect(fetchOne).toHaveBeenCalledTimes(4);
    expect(dump().keys.sort()).toEqual(['a', 'b c']);
  });

  // story #4440 qa:changes P1(카디르, 2026-09-19) — 이 헬퍼가 막으려던 바로 그 버그가
  // 배치 자신의 Promise.all에서 재현됐다: fetchOne이 하나라도 reject하면 Promise.all이
  // 즉시 reject하고, 뒤따르는 setLoading(false)에 영영 못 도달했다(+unhandled rejection).
  // Promise.allSettled로 그 reject를 그 key만의 실패로 수렴시키는지 pin.
  it('fetchOne 중 하나가 reject해도 loading이 고착되지 않고, 그 key만 결과에서 빠진다(#4440 핵심 회귀)', async () => {
    const fetchOne = vi.fn(async (k: string) => {
      if (k === 'bad') throw new Error('boom');
      return `v:${k}`;
    });
    await act(async () => { root.render(<Harness keys={['a', 'bad']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: ['a'], loading: false, loadFailed: false });
  });

  it('전부 reject하면 loading이 고착되지 않고 loadFailed=true다', async () => {
    const fetchOne = vi.fn(async () => { throw new Error('boom'); });
    await act(async () => { root.render(<Harness keys={['a']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: [], loading: false, loadFailed: true });
  });

  // story #4440 qa:changes round-2(카디르, 2026-09-19) — 위 두 테스트는 fetchOne이 async라
  // 항상 "비동기" reject였다. fetchOne이 async 없이 선언돼(호출부 실수) await 前에 **동기**
  // throw하면 다른 실패 경로다 — resolvedKeys.map((k) => fetchOne(k)) 자체가 .map() 안에서
  // 동기 throw해 Promise.allSettled에 배열이 넘어가기도 전에 async 블록 전체가 죽는다.
  it('fetchOne이 async 없이 호출 즉시(동기) throw해도 loading이 고착되지 않는다(round-2 핵심 회귀 — 비동기 reject와 다른 경로)', async () => {
    // 의도적으로 async 없는 함수 — 반환 전에 동기적으로 throw한다(타입상 Promise를
    // 반환해야 하지만, 실전에서 호출부가 이 계약을 어기는 걸 이 헬퍼가 막아야 한다).
    const fetchOne = vi.fn((): Promise<string | null> => { throw new Error('sync boom'); });
    await act(async () => { root.render(<Harness keys={['a', 'b']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: [], loading: false, loadFailed: true });
  });

  it('일부만 동기 throw해도(나머지는 정상) 그 key만 빠지고 loading은 고착되지 않는다(round-2)', async () => {
    const fetchOne = vi.fn((k: string): Promise<string | null> => {
      if (k === 'bad') throw new Error('sync boom');
      return Promise.resolve(`v:${k}`);
    });
    await act(async () => { root.render(<Harness keys={['a', 'bad']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: ['a'], loading: false, loadFailed: false });
  });

  // story #4440 qa:changes P2(카디르) — key가 "__proto__"면 plain object 직접대입이
  // own property가 아니라 프로토타입 체인을 오염시켜 그 key가 조용히 사라질 수 있다
  // (Object.create(null) 사용으로 구조 방지).
  it('key가 "__proto__"여도 그 결과가 own property로 정상 보존된다(프로토타입 오염 방지, P2)', async () => {
    const fetchOne = vi.fn(async (k: string) => `v:${k}`);
    await act(async () => { root.render(<Harness keys={['__proto__']} fetchOne={fetchOne} />); });
    await flush();
    expect(dump()).toEqual({ keys: ['__proto__'], loading: false, loadFailed: false });
  });
});
