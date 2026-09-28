import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-no-hardcoded-english-browser-dialog';

// story #4359 — 양성 대조(스캔이 비어 공허하게 통과하지 않게) + 음성 대조(t() · 식 · 비문구는 안 걸림).
describe('verify-no-hardcoded-english-browser-dialog', () => {
  it('⭐prompt · window.prompt · confirm · alert의 영어 문구 인자를 잡는다(이번 PR이 고친 실사고 모양)', () => {
    const src = `function r() { prompt('Enter new title:', 'a'); window.prompt('URL:'); confirm("Delete this doc?"); window.alert(\`Saved!\`); }`;
    expect(scanContent(src, 'x.ts').map((r) => r.call)).toEqual(['prompt()', 'prompt()', 'confirm()', 'alert()']);
  });

  it('t() · 변수 · 다른 함수의 같은 모양은 걸리지 않는다', () => {
    const src = `function r(t: (k: string) => string, msg: string) { prompt(t('linkUrlPrompt')); confirm(msg); editor.prompt('URL:'); log('URL:'); }`;
    expect(scanContent(src, 'x.ts')).toEqual([]);
  });
});
