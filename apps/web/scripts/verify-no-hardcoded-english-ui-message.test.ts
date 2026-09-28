import { describe, expect, it } from 'vitest';
import { JSX_EXPR_BASELINE, OBJECT_PROP_ALLOWLIST, OBJECT_PROP_BASELINE, judge, scanContent } from './verify-no-hardcoded-english-ui-message';

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

  it('BASELINE은 줄이기만 — 고친 자리가 BASELINE에 남으면 stale로 FAIL(JSX 식 · 객체 속성 둘 다)', () => {
    const { stale } = judge([]);
    expect(stale).toEqual([...JSX_EXPR_BASELINE.keys(), ...OBJECT_PROP_BASELINE.keys()]);
  });

  // story #4377 — 객체 리터럴의 사람용 속성(문서 편집기 슬래시 메뉴 제목 20개가 이 모양으로 한국어 화면에 영어로 떴다).
  it('⭐객체(배열 안 객체 포함)의 title · label · description · placeholder 영어 문장을 잡는다', () => {
    const src = `
      const items = [
        { id: 'h1', title: 'Heading 1', description: strings.h1 },
        { id: 'pe', title: 'Page Embed', label: 'Embed a page', placeholder: 'Search docs…' },
      ];`;
    expect(scanContent(src, 'x.tsx').map((r) => [r.where, r.value])).toEqual([
      ['{title: …}', 'Heading 1'], ['{title: …}', 'Page Embed'], ['{label: …}', 'Embed a page'], ['{placeholder: …}', 'Search docs…'],
    ]);
  });

  it('객체 속성이라도 t() · 한글 · i18n 키 이름(camelCase) · 클래스(kebab) · 사람용이 아닌 키 · toast 인자(toast 축이 셈)는 안 걸린다', () => {
    const src = `
      const a = { title: t('x.title'), label: '제목 1', ctaLabel: 'intentSuggestionApprovalCta', tone: 'text-muted-foreground' };
      const b = { label: 'intentSuggestionApprovalCta', description: 'text-foreground', name: 'Heading 1', message: 'Something failed' };
      addToast({ title: 'Saved changes' });`;
    expect(scanContent(src, 'x.tsx').map((r) => [r.where, r.value])).toEqual([['addToast({title})', 'Saved changes']]);
  });

  it('객체 속성 ALLOWLIST(브랜드 등)는 신규가 아니고, 등재 밖 같은 값은 신규다', () => {
    const [brand] = [...OBJECT_PROP_ALLOWLIST.keys()].filter((k) => k.startsWith('components/settings/linked-accounts-section.tsx::'));
    const [file, value] = brand!.split('::');
    const ref = { file: file!, line: 1, where: '{label: …}', value: value! };
    expect(judge([ref]).fresh).toEqual([]);
    expect(judge([{ ...ref, file: 'components/other.tsx' }]).fresh).toHaveLength(1);
  });
});
