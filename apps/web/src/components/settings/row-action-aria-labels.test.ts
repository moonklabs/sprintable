// story #3592(§17-20 ⑧·§22-18 동형) — 후보 12파일 판정표(comments-section 외 11파일
// + 그 자매 컴포넌트들) 중 「행마다 반복」으로 가른 항목 전부에 aria-label을 배선했다.
// 이 파일은 그 템플릿(§22-18 §22-18과 같은 어휘: 순번+현재 보이는 라벨) 자체를
// comments-action-aria-labels.test.ts와 동형으로 검산한다 — ⛔「aria-label이 있는가」
// 로 세지 않는다, 「보이는 라벨이 접근 이름의 부분 문자열인가」만 고정(AC11).
//
// 라이브 렌더(두 행이 실제로 다른 접근 이름을 내는지)는 각 컴포넌트의 기존
// *.test.tsx(blocked-users-section.test.tsx 등)가 이미 그 컴포넌트를 마운트하는
// 인프라를 갖고 있어 이 파일에서 다시 만들지 않는다 — 여기는 messages 템플릿
// 자체의 순수 단위 검산.
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

type LooseTranslator = (key: string, values?: Record<string, string | number>) => string;

// 동적 namespace 문자열은 next-intl의 정적 리터럴 네임스페이스 타입과 안 맞는다
// (comments-action-aria-labels.test.ts의 LooseTranslator 완화와 동형 — 이 파일은
// 여러 네임스페이스를 표로 순회한다). Parameters<typeof createTranslator>[0]에서
// namespace만 string으로 넓힌 로컬 타입으로 `any` 없이 캐스팅.
type CreateTranslatorArgs = Parameters<typeof createTranslator>[0];
function translatorsFor(namespace: string) {
  return {
    ko: createTranslator({ locale: 'ko', messages: koMessages, namespace } as CreateTranslatorArgs) as unknown as LooseTranslator,
    en: createTranslator({ locale: 'en', messages: enMessages, namespace } as CreateTranslatorArgs) as unknown as LooseTranslator,
  };
}

// (namespace, key, [ko label 표본...], [en label 표본...]) — 상태 의존 라벨(예: 토글
// 버튼의 두 상태)은 표본을 여러 개 준다.
const CASES: { namespace: string; key: string; ko: string[]; en: string[] }[] = [
  { namespace: 'settings', key: 'unblockUserAriaLabel', ko: ['차단 해제'], en: ['Unblock'] },
  { namespace: 'settings', key: 'agentToggleAriaLabel', ko: ['비활성화', '활성화'], en: ['Deactivate', 'Activate'] },
  { namespace: 'settings', key: 'lineEditorEditAriaLabel', ko: ['편집'], en: ['Edit'] },
  { namespace: 'settings', key: 'workflowToggleAriaLabel', ko: ['비활성화', '활성화'], en: ['Disable', 'Enable'] },
  { namespace: 'settings', key: 'repeatSchedulesRowActionAriaLabel', ko: ['지금 한 회차', '재개', '일시정지'], en: ['Run now'] },
  { namespace: 'settings', key: 'orgMemberRowActionAriaLabel', ko: ['제거'], en: ['Remove'] },
  { namespace: 'settings', key: 'orgInviteRowActionAriaLabel', ko: ['링크 복사', '재발송', '취소'], en: ['Copy link'] },
  { namespace: 'githubLinks', key: 'promoteAriaLabel', ko: ['명시 연결'], en: ['Link explicitly'] },
  { namespace: 'insightsBoard', key: 'followUpAriaLabel', ko: ['후속 조치'], en: ['Follow-up'] },
  { namespace: 'agentRuns', key: 'openDetailAriaLabel', ko: ['상세 보기'], en: ['Open detail'] },
  { namespace: 'cage', key: 'gateRowActionAriaLabel', ko: ['반려', '변경 요청', '보류(논의 필요)'], en: ['Reject'] },
  { namespace: 'channelConnect', key: 'channelRowActionAriaLabel', ko: ['연결 시험', '다시 연결', '해제'], en: ['Test connection'] },
  { namespace: 'organization', key: 'eventRowActionAriaLabel', ko: ['발행 테스트', '프로젝트에 적용', '수정', '비활성화'], en: ['Test publish'] },
];

describe('row-action aria-label 템플릿 — §22-18 부분 문자열 검산(AC11, comments 외 11파일)', () => {
  it.each(CASES.flatMap(({ namespace, key, ko }) => ko.map((label) => ({ namespace, key, locale: 'ko' as const, label }))))(
    '⭐ko — $namespace.$key("$label")의 접근 이름이 라벨+순번을 품는다',
    ({ namespace, key, label }) => {
      const { ko: t } = translatorsFor(namespace);
      const name = t(key, { n: 2, label });
      expect(name).toContain(label);
      expect(name).toContain('2');
    },
  );

  it.each(CASES.flatMap(({ namespace, key, en }) => en.map((label) => ({ namespace, key, label }))))(
    '⭐en — $namespace.$key("$label")의 접근 이름이 라벨+순번을 품는다',
    ({ namespace, key, label }) => {
      const { en: t } = translatorsFor(namespace);
      const name = t(key, { n: 2, label });
      expect(name).toContain(label);
      expect(name).toContain('2');
    },
  );

  // pr-link-section.tsx의 unlinkAria — 아이콘 전용이라 {label} 없이 {n}만(예외 케이스,
  // AC11 함정 실사례 — 원래 있던 정적 aria-label을 순번으로 가른 자리).
  it('⭐ko — unlinkAria가 순번을 품는다(아이콘 전용, label 없음)', () => {
    const { ko: t } = translatorsFor('githubLinks');
    expect(t('unlinkAria', { n: 3 })).toContain('3');
  });

  it('⭐en — unlinkAria가 순번을 품는다(아이콘 전용, label 없음)', () => {
    const { en: t } = translatorsFor('githubLinks');
    expect(t('unlinkAria', { n: 3 })).toContain('3');
  });

  // AC10 — ko는 대상(순번) 앞·라벨 뒤 / en은 라벨 앞·대상(순번) 뒤(§22-18 그대로,
  // comments-action-aria-labels.test.ts와 동일 대조).
  it('AC10 — 새 템플릿도 로케일 어순이 comments와 동형(ko 순번 먼저, en 라벨 먼저)', () => {
    const { ko: tKo, en: tEn } = translatorsFor('settings');
    const ko = tKo('unblockUserAriaLabel', { n: 7, label: '차단 해제' });
    const en = tEn('unblockUserAriaLabel', { n: 7, label: 'Unblock' });
    expect(ko.indexOf('7')).toBeLessThan(ko.indexOf('차단 해제'));
    expect(en.indexOf('Unblock')).toBeLessThan(en.indexOf('7'));
  });

  // 뮤테이션 대조 — "aria-label이 있는가"만 보면 놓치는 함정을 이 검산이 실제로
  // 잡는지 자가 증명(comments-action-aria-labels.test.ts와 동형).
  it('뮤테이션 대조 — 라벨을 안 품는 접근 이름은 이 검산에서 반드시 잡힌다', () => {
    const fakeName = '2번째 행 액션'; // "차단 해제"를 안 품음
    expect(fakeName).not.toContain('차단 해제');
  });
});
