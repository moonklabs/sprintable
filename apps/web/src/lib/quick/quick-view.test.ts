import { describe, expect, it } from 'vitest';
import { parsePost, parseQuickState, type QuickViewState } from './quick-view';

const OK: QuickViewState = { open: true, phase: 'empty', text: 'hi', target: { kind: 'agent', id: 'a', name: 'Dan' }, pickQuery: '', attach: { kind: 'off' }, failure: null };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('[SID:5047] the state the app gives the page', () => {
  it('a state in the shape is taken as it is', () => {
    expect(parseQuickState(OK)).toEqual(OK);
    expect(parseQuickState({ ...OK, phase: 'failed', failure: 'server', target: null, attach: { kind: 'ready', preview: { dataUrl: PNG, label: '창 · 터미널' } } })).not.toBeNull();
    expect(parseQuickState({ ...OK, attach: { kind: 'denied', permission: 'denied' } })?.attach).toEqual({ kind: 'denied', permission: 'denied' });
  });

  it.each([
    ['not an object', 'x'], ['null', null], ['no open flag', { ...OK, open: 'yes' }], ['an unknown phase', { ...OK, phase: 'closing' }], ['text that is not text', { ...OK, text: 5 }],
    ['a target with a wrong kind', { ...OK, target: { kind: 'root', id: 'a', name: 'b' } }], ['a target without an id', { ...OK, target: { kind: 'agent', id: '', name: 'b' } }],
    ['an unknown failure', { ...OK, failure: 'exploded' }], ['an unknown attach', { ...OK, attach: { kind: 'sticky' } }],
    ['a picture that is not an image address (an https address would be loaded)', { ...OK, attach: { kind: 'ready', preview: { dataUrl: 'https://evil.example/x.png', label: 'x' } } }],
    ['a picture that is a javascript address', { ...OK, attach: { kind: 'ready', preview: { dataUrl: 'javascript:alert(1)', label: 'x' } } }],
    ['a picture of another type (svg can carry script)', { ...OK, attach: { kind: 'ready', preview: { dataUrl: 'data:image/svg+xml;base64,AAAA', label: 'x' } } }],
  ])('%s is dropped', (_n, raw) => {
    expect(parseQuickState(raw)).toBeNull();
  });
});

describe('[SID:5047] what the app asks the page to send', () => {
  it('words + a target (+ a picture or none)', () => {
    expect(parsePost({ text: 'hi', target: { kind: 'channel', id: 'c', name: 'P' }, picture: null })).toEqual({ text: 'hi', target: { kind: 'channel', id: 'c', name: 'P' }, picture: null });
    expect(parsePost({ text: 'hi', target: { kind: 'agent', id: 'a', name: 'D' }, picture: PNG })?.picture).toBe(PNG);
  });
  it.each([['no target', { text: 'hi', picture: null }], ['a picture that is not an image', { text: 'hi', target: { kind: 'agent', id: 'a', name: 'D' }, picture: 'https://x/y.png' }], ['not an object', 3]])('%s is dropped', (_n, raw) => {
    expect(parsePost(raw)).toBeNull();
  });
});
