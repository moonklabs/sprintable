import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-no-hardcoded-english-ui-message';

// story #4359 — 양성 대조(이번 PR이 고친 실사고 모양) + 음성 대조(t() · 상태 코드 · 상태 setter).
describe('verify-no-hardcoded-english-ui-message', () => {
  it('⭐오류 · 안내 setter와 toast 문자열의 영어 문장을 잡는다', () => {
    const src = `
      function f(setError: any, setNotice: any, addToast: any, toast: any) {
        setError('That code did not match. Please try again.');
        setNotice("Document not found");
        addToast({ type: 'error', title: 'Error', body: 'Failed to load API keys' });
        toast.success('Webhook URL saved');
      }`;
    expect(scanContent(src, 'x.ts').map((r) => r.where)).toEqual(['setError()', 'setNotice()', 'addToast({title})', 'addToast({body})', 'success()']);
  });

  it('t() · 상태 코드(소문자 한 낱말) · 상태 setter · 변수는 걸리지 않는다', () => {
    const src = `
      function f(t: (k: string) => string, setError: any, setStatus: any, setTransitionError: any, addToast: any, msg: string) {
        setError(t('mfa.errorFailed'));
        setTransitionError('forbidden');
        setStatus('Loading');
        addToast({ title: t('x'), body: msg });
      }`;
    expect(scanContent(src, 'x.ts')).toEqual([]);
  });
});
