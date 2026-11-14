// @vitest-environment jsdom
//
// story 4937 — a screen the server drew is taken over by React later; what was typed / ticked in between lives in the DOM only. `useAdoptPrehydrationValues` takes it into the state once, right after the screen is alive — and only then, and only when
// the state is still the first value. Real server markup (`renderToString`) · a value put into the DOM BEFORE `hydrateRoot` · the real hook.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useRef, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useAdoptPrehydrationValues } from './use-adopt-prehydration-values';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ initial = '', initialBox = false, normalize, withField = true }: { initial?: string; initialBox?: boolean; normalize?: (v: string) => string; withField?: boolean }) {
  const [v, setV] = useState(initial);
  const [on, setOn] = useState(initialBox);
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLInputElement>(null);
  useAdoptPrehydrationValues([{ ref, initial, set: setV, normalize, onAdopted: () => setTouched(true) }], [{ ref: boxRef, initial: initialBox, set: setOn }]);
  return (
    <div>
      {withField ? <input data-testid="f" ref={ref} value={v} onChange={(e) => setV(e.target.value)} /> : null}
      <input data-testid="b" type="checkbox" ref={boxRef} checked={on} onChange={(e) => setOn(e.target.checked)} />
      <output data-testid="state">{JSON.stringify({ v, on, touched })}</output>
    </div>
  );
}

let container: HTMLDivElement; let root: Root | null;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = null; });
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); });

async function alive(node: React.ReactElement, before: (el: { f: HTMLInputElement | null; b: HTMLInputElement }) => void) {
  container.innerHTML = renderToString(node); // the server's markup
  before({ f: container.querySelector('[data-testid="f"]'), b: container.querySelector('[data-testid="b"]')! }); // typed / ticked while the screen is not alive yet
  await act(async () => { root = hydrateRoot(container, node); });
}
const state = () => JSON.parse(container.querySelector('[data-testid="state"]')!.textContent!) as { v: string; on: boolean; touched: boolean };
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('useAdoptPrehydrationValues', () => {
  it('⭐a word typed BEFORE the screen is alive becomes the state (and stays on the screen); the field\'s own onChange effect (onAdopted) runs', async () => {
    await alive(<Probe />, ({ f }) => { f!.value = '먼저 친 글'; });
    expect(state()).toEqual({ v: '먼저 친 글', on: false, touched: true });
    expect((container.querySelector('[data-testid="f"]') as HTMLInputElement).value).toBe('먼저 친 글');
  });
  it('⭐a box ticked BEFORE (a hidden input only) shows ticked after, and its state is on', async () => {
    await alive(<Probe />, ({ b }) => { b.checked = true; });
    expect(state().on).toBe(true);
    expect((container.querySelector('[data-testid="b"]') as HTMLInputElement).checked).toBe(true);
  });
  it('a value the SERVER filled (the first value) is left as it is: nothing is adopted, onAdopted does not run', async () => {
    await alive(<Probe initial="invited@example.test" />, () => {});
    expect(state()).toEqual({ v: 'invited@example.test', on: false, touched: false });
  });
  it('a person who typed OVER a server-filled value before it was alive: what is on the screen wins', async () => {
    await alive(<Probe initial="invited@example.test" />, ({ f }) => { f!.value = 'mine@example.test'; });
    expect(state().v).toBe('mine@example.test');
  });
  it('⭐it runs ONCE: a word typed after the screen is alive is never overwritten by the DOM\'s', async () => {
    await alive(<Probe />, ({ f }) => { f!.value = '먼저'; });
    await type(container.querySelector('[data-testid="f"]') as HTMLInputElement, '나중에');
    expect(state().v).toBe('나중에');
  });
  it('the field\'s own cleaning (normalize) is applied to what is taken — digits only here', async () => {
    await alive(<Probe normalize={(v) => v.replace(/\D/g, '').slice(0, 6)} />, ({ f }) => { f!.value = '12a345'; });
    expect(state().v).toBe('12345');
  });
  it('a field that is not drawn (no ref) is skipped — nothing throws', async () => {
    await alive(<Probe withField={false} />, ({ b }) => { b.checked = true; });
    expect(state()).toEqual({ v: '', on: true, touched: false });
  });
});
