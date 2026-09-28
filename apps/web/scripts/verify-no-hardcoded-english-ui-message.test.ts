import { describe, expect, it } from 'vitest';
import { JSX_EXPR_BASELINE, judge, scanContent } from './verify-no-hardcoded-english-ui-message';

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

  // 까디르(4740 ②) — JSX 자식 식 안 문자열 · 템플릿(글자 가드가 못 보던 자리).
  it('⭐JSX 식 안 삼항 · && · 템플릿의 영어(기호 • ⚠ 섞여도)를 잡는다', () => {
    const src = `
      const A = ({ copied, k, d }: any) => (
        <p>
          {copied ? 'Copied!' : 'Copy'}
          {k && \` • Last used: \${k}\`}
          {d > 0 ? \`⚠ Expires in \${d} days\` : null}
        </p>
      );`;
    expect(scanContent(src, 'x.tsx').map((r) => r.value)).toEqual(['Copied!', 'Copy', ' • Last used:  ', '⚠ Expires in   days']);
  });

  it('JSX 식 안이라도 t() · 한글 · 상태 코드 · 호출 인자 · 비교는 걸리지 않는다', () => {
    const src = `
      const A = ({ t, s, f }: any) => (
        <p>
          {s === 'closed' ? t('closed') : '열림'}
          {f(\`Hello \${s}\`)}
          {s ?? 'none'}
        </p>
      );`;
    expect(scanContent(src, 'x.tsx')).toEqual([]);
  });

  it('BASELINE은 줄이기만 — 고친 자리가 BASELINE에 남으면 stale로 FAIL', () => {
    const { stale } = judge([]);
    expect(stale).toEqual([...JSX_EXPR_BASELINE.keys()]);
  });
});
