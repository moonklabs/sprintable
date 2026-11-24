// @vitest-environment jsdom
//
// story 4994 (P4-c3c-3) — the claim ORDER the desktop guest's bridge relies on (design: the shell's handle is taken before any frame of the page can exist). The guest desktop's preload puts `window.__sprintablePhone` in the top frame at document start (no «late claim» watch
// there: that is only for React Native's WebView); a same-origin iframe could reach `window.parent.__sprintablePhone` if the page had not taken it first. So the web must claim (1) in the ROOT render, BEFORE any child renders, and (2) with the layout putting the claim FIRST in
// <body>, wrapping everything else (the behaviour is tested by rendering; the layout is a source pin like the repo's other guards — the render-phase rule is the behaviour test, not a string search). Each test goes red when its rule is taken out.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';
import { __resetPhoneBridgeForTest } from '@/lib/phone-bridge';

const watch = vi.hoisted(() => ({ startHandoffWatch: vi.fn(), stopHandoffWatch: vi.fn() }));
vi.mock('@/lib/phone-handoff-watch', () => ({ startHandoffWatch: watch.startHandoffWatch, stopHandoffWatch: watch.stopHandoffWatch, ON_OPEN_MS: 60_000, AFTER_PAIRING_MS: 600_000 }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { __resetPhoneBridgeForTest(); delete window.__sprintablePhone; document.body.innerHTML = ''; });

/** what the guest's preload (and the phone's injection) hands the top frame: ONE claim, and a later frame that asks gets nothing */
function installHandle() {
  const events: string[] = []; let taken = false;
  window.__sprintablePhone = { claim: () => { events.push('claim'); if (taken) return null; taken = true; return () => undefined; } };
  return events;
}

describe('[SID:4994] the web claims the shell\'s handle first', () => {
  it('the claim is made in the root\'s own render — BEFORE any child renders (a frame a child draws can never reach the handle first)', async () => {
    const events = installHandle();
    function Child() { events.push('child render'); return <p>child</p>; }
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><Child /></PhoneBridgeClaim>); });
    expect(events[0], 'the first thing that happens is the claim').toBe('claim');
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('child render'));
    await act(async () => { root.unmount(); });
  });

  it('a same-origin frame that asks for the handle AFTER the first render gets nothing (it was taken once)', async () => {
    installHandle(); // (the same object a frame would reach through `window.parent`)
    const handle = window.__sprintablePhone!;
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><p>x</p></PhoneBridgeClaim>); });
    expect(handle.claim(() => undefined), 'a later claim is refused').toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('the app layout puts <PhoneBridgeClaim> FIRST in <body>, wrapping everything else (nothing renders outside it)', () => {
    const layout = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'layout.tsx'), 'utf8');
    const start = layout.search(/<body\b[^>]*className=/); // (the element — comments in the layout name «<body>» too)
    expect(start).toBeGreaterThan(-1);
    const body = layout.slice(start, layout.indexOf('</body>', start));
    expect(body).toMatch(/^<body[^>]*>\s*<PhoneBridgeClaim>/);
    expect(body.trimEnd()).toMatch(/<\/PhoneBridgeClaim>$/);
    expect(body.match(/<PhoneBridgeClaim>/g)).toHaveLength(1);
    expect(body.match(/<\/PhoneBridgeClaim>/g), 'one open · one close').toHaveLength(1);
    // everything the layout renders in the body sits inside the claim
    const inner = body.slice(body.indexOf('<PhoneBridgeClaim>') + '<PhoneBridgeClaim>'.length, body.indexOf('</PhoneBridgeClaim>'));
    for (const tag of ['<ThemeProvider', '<NextIntlClientProvider', '{children}']) expect(inner, tag).toContain(tag);
    expect(body.slice(0, body.indexOf('<PhoneBridgeClaim>')), 'nothing before the claim in the body').not.toMatch(/<(?!body)[A-Za-z]/);
  });

  it('a re-render (state change · parent update) does not ask the shell again — one claim for the whole life of the page', async () => {
    const events = installHandle();
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><p>1</p></PhoneBridgeClaim>); });
    await act(async () => { root.render(<PhoneBridgeClaim><p>2</p></PhoneBridgeClaim>); });
    await act(async () => { root.render(<PhoneBridgeClaim><p>3</p></PhoneBridgeClaim>); });
    expect(events.filter((e) => e === 'claim')).toHaveLength(1);
    await act(async () => { root.unmount(); });
  });
});
