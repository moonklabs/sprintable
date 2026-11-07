// story 4854 — the pure rules of chat links (chat-link-rules.ts).
import { describe, expect, it } from 'vitest';
import { classifyChatHref, HAS_MENTION_RE, MENTION_RE, splitPlainUrls } from './chat-link-rules';

describe('[SID:4854] classifyChatHref — what a chat link may be', () => {
  it('http · https are web links, mailto is a mail link', () => {
    for (const h of ['https://example.org/md-link', 'http://example.com/plain', 'HTTPS://EXAMPLE.ORG/x', 'https://dev-app.sprintable.ai/chats?p=1#m']) expect(classifyChatHref(h), h).toBe('web');
    for (const h of ['mailto:probe@example.org', 'mailto:probe@example.org?subject=hi']) expect(classifyChatHref(h), h).toBe('mail');
  });
  it('an empty address (a javascript: link the markdown reader emptied), any other kind and anything with a space or control character is not a link', () => {
    for (const h of ['', 'javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ai.sprintable:/desktop/setup', 'tel:123', 'sms:1', 'ftp://example.org/x', 'irc://example.org/x', '/relative/path', '#frag', '//example.org/x', 'https://exa mple.org', ' https://example.org', 'not a url', undefined, null, 42])
      expect(classifyChatHref(h), JSON.stringify(h)).toBe('none');
  });
});

describe('[SID:4854] splitPlainUrls — a plain message cut into text and addresses', () => {
  const texts = (s: string) => splitPlainUrls(s).map((p) => `${p.kind === 'url' ? 'URL' : 'T'}:${p.value}`);
  it('a bare address in a sentence', () => {
    expect(texts('BARE-URL https://example.net/bare-url end')).toEqual(['T:BARE-URL ', 'URL:https://example.net/bare-url', 'T: end']);
    expect(texts('https://example.net/only')).toEqual(['URL:https://example.net/only']);
  });
  it('whitespace and line breaks are kept as typed', () => {
    expect(texts('a  b\nhttps://x.example/y\n\nc')).toEqual(['T:a  b\n', 'URL:https://x.example/y', 'T:\n\nc']);
  });
  it('sentence punctuation and an unbalanced closing bracket are not part of the address; a balanced one is', () => {
    expect(texts('see https://example.net/x.')).toEqual(['T:see ', 'URL:https://example.net/x', 'T:.']);
    expect(texts('(https://example.net/y)')).toEqual(['T:(', 'URL:https://example.net/y', 'T:)']);
    expect(texts('https://en.wikipedia.org/wiki/Foo_(bar) ok')).toEqual(['URL:https://en.wikipedia.org/wiki/Foo_(bar)', 'T: ok']);
    expect(texts('a https://example.net/z?q=1&r=2, b')).toEqual(['T:a ', 'URL:https://example.net/z?q=1&r=2', 'T:, b']);
  });
  it('a Korean particle written right after the address is not part of it', () => {
    expect(texts('https://example.org/abc를 확인')).toEqual(['URL:https://example.org/abc', 'T:를 확인']);
  });
  it('several addresses, http as well as https', () => {
    expect(texts('a http://one.example/ b https://two.example/')).toEqual(['T:a ', 'URL:http://one.example/', 'T: b ', 'URL:https://two.example/']);
  });
  it('what is not an http(s) address stays text: mailto · javascript: · a bare host · a word that ends in http', () => {
    for (const s of ['probe@example.org', 'javascript:alert(1)', 'www.example.org/z', 'xhttp://example.org/x', 'https://', 'https:///x', 'https://?q=1', 'https:// not-a-host', 'plain words only']) expect(splitPlainUrls(s).every((p) => p.kind === 'text'), s).toBe(true);
  });
});

describe('[SID:4854] mentions — an @name that starts a word, not the middle of an e-mail address', () => {
  it('real mentions are found', () => {
    for (const s of ['hello @alice', '@alice', '(see @alice)', 'a,@bob', '담롱 @담롱 확인']) expect(HAS_MENTION_RE.test(s), s).toBe(true);
    expect('hi @alice and @bob'.replace(MENTION_RE, '[@$1](mention:$1)')).toBe('hi [@alice](mention:alice) and [@bob](mention:bob)');
  });
  it('an e-mail address holds no mention', () => {
    for (const s of ['probe@example.org', 'a.b+c@example.org', 'first-last@example.org']) { expect(HAS_MENTION_RE.test(s), s).toBe(false); expect(s.replace(MENTION_RE, 'X'), s).toBe(s); }
    expect('mail probe@example.org or ping @alice'.replace(MENTION_RE, '[@$1](mention:$1)')).toBe('mail probe@example.org or ping [@alice](mention:alice)');
  });
  it('an @name right after [ or ( is left alone, as before (it is already inside a markdown link)', () => {
    expect('[@alice](mention:alice)'.replace(MENTION_RE, 'X')).toBe('[@alice](mention:alice)');
    expect(HAS_MENTION_RE.test('(@alice)')).toBe(false);
  });
});
