// story #3592(유나 §22-18 정본, PO 確定 2026-09-06 16:30Z) — 댓글 목록 행 액션 접근
// 이름 검산. 항목 식별자는 «순번»(작성자 아님 — AC1·AC7의 «작성자» 형은 §22-18에서
// 폐기됐다: 같은 사람이 여러 댓글을 달거나 작성자 정보가 없으면 순번만이 가른다).
//
// 반복 컨트롤 «여섯»(§22-18 표 그대로, 새 낱말 0):
//   ① 작업으로 전환  ② 답변/답변 더하기/이어서 답변(3갈래)  ③ 채널에서 보기
//   ④ 다시 보내기    ⑤ 다시 상신                              ⑥ 더 보기(<details><summary>)
//
// AC11 — 검산은 «보이는 라벨이 접근 이름의 부분 문자열인가»(Label in Name, WCAG 2.5.3
// 확장)로 고정한다. ⛔「aria-label이 있는가」로 세지 않는다 — 있는데 라벨을 안 품는
// 것이 이 규칙이 막는 그것(§17-20 ⑧과 같은 사상 — 이름은 같아도 되고 다르지 않아도
// 된다, 다만 반드시 "그 라벨을 포함"해야 한다).
//
// AC10 — 로케일 어순은 일부러 다르다: ko는 «대상 앞·라벨 뒤», en은 «라벨 앞·대상
// 뒤»(Label in Name 요건상 en이 라벨을 쪼개면 안 되므로 라벨을 통째로 앞에 둔다).
// 「두 로케일이 달라 보이니 맞추자」로 고치지 않는다(§22-18 그대로).
//
// 스코프 — 이 스토리 WIP1(PO 지시 2026-09-07 01:26Z)은 i18n 12줄+이 검산 스캐폴드
// 까지다. comments-section.tsx 실배선(aria-label prop 부착)은 #3953(story #3596 FE,
// 같은 파일) 착지 신호 뒤로 미룬다(파일 겹침 회피) — 그래서 이 테스트는 아직 컴포넌트를
// 마운트하지 않고 messages 템플릿 자체를 `createTranslator`로 직접 검증한다(#3953
// 착지 뒤 실 렌더 접근성 트리 검증을 별도로 얹는다).
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

// story #3592 — 6개 aria-label 템플릿 키를 동적 문자열(테이블 기반 it.each)로 조회하므로
// next-intl의 정적 리터럴 키 타입과 안 맞는다(command-palette-actions.test.ts와 동형 완화).
type LooseTranslator = (key: string, values?: Record<string, string | number>) => string;
const tKo = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'content' }) as unknown as LooseTranslator;
const tEn = createTranslator({ locale: 'en', messages: enMessages, namespace: 'content' }) as unknown as LooseTranslator;

// story #3592 — 5개 컨트롤은 그때 보이는 라벨을 {label}로 그대로 품는다(고정 낱말
// 금지, AC7). 「더 보기」만 예외 — moreLabel 자체가 이 템플릿과 별도 프롭이 아니라
// <summary> 전용 고정 문구라 §22-18 표가 낱말을 템플릿에 직접 못박았다(아래 별도
// 케이스). ko 「더보기」는 commentsMoreLabel 실값과 정확히 맞춘다(PO 채팅 프로즈의
// 「더 보기」 띄어쓰기는 코드베이스 전역 관례(다른 12+ 파일)와 어긋나 그대로 안 따름 —
// 새 띄어쓰기를 실 CTA에 퍼뜨리지 않는다, 템플릿만 실값에 맞춘다).
const PARAMETERIZED_CASES: { key: string; ko: string[]; en: string[] }[] = [
  { key: 'commentsConvertToTaskAriaLabel', ko: ['작업으로 전환'], en: ['Convert to task'] },
  // 답변 3갈래(AC9) — 「이어서 답변」/"Continue reply"는 #3953(3596 FE) 착지 前이라
  // 아직 실 CTA 키가 없다(BE open_reply_draft additive만 착지·FE 미배선). 템플릿이
  // 임의 라벨을 올바르게 품는지 구조 검증용 표본 문자열 — #3953 착지 뒤 실 키로 교체.
  { key: 'commentsReplyAriaLabel', ko: ['답변', '답변 더하기', '이어서 답변'], en: ['Reply', 'Add another reply', 'Continue reply'] },
  { key: 'commentsViewOnChannelAriaLabel', ko: ['채널에서 보기'], en: ['View on channel'] },
  { key: 'commentsRetryAriaLabel', ko: ['다시 보내기'], en: ['Send again'] },
  { key: 'commentsResubmitAriaLabel', ko: ['다시 상신'], en: ['Resubmit'] },
];

describe('comments-action-aria-labels — §22-18 부분 문자열 검산(AC11)', () => {
  it.each(PARAMETERIZED_CASES.flatMap(({ key, ko, en }) => ko.map((label, i) => ({ key, locale: 'ko' as const, label, en: en[i]! }))))(
    '⭐ko — $key("$label")의 접근 이름이 그 라벨을 부분 문자열로 품는다(순번 포함)',
    ({ key, label }) => {
      const name = tKo(key, { n: 3, label });
      expect(name).toContain(label);
      expect(name).toContain('3');
    },
  );

  it.each(PARAMETERIZED_CASES.flatMap(({ key, en }) => en.map((label) => ({ key, label }))))(
    '⭐en — $key("$label")의 접근 이름이 그 라벨을 부분 문자열로 품는다(순번 포함)',
    ({ key, label }) => {
      const name = tEn(key, { n: 3, label });
      expect(name).toContain(label);
      expect(name).toContain('3');
    },
  );

  // 「더 보기」— 고정 낱말이 이미 템플릿에 박혀 있다(§22-18 표 그대로, 위 docstring
  // 참고). 실 commentsMoreLabel 값과 어긋나면(코드베이스 전역 관례 변경 등) 이 자리가
  // 가장 먼저 깨져야 한다 — 그래서 label을 리터럴로 안 넣고 실제 상수 키에서 읽는다.
  it('⭐ko — commentsMoreAriaLabel이 실 commentsMoreLabel 값을 부분 문자열로 품는다', () => {
    const visibleLabel = tKo('commentsMoreLabel');
    const name = tKo('commentsMoreAriaLabel', { n: 3 });
    expect(name).toContain(visibleLabel);
    expect(name).toContain('3');
  });

  it('⭐en — commentsMoreAriaLabel이 실 commentsMoreLabel 값을 부분 문자열로 품는다', () => {
    const visibleLabel = tEn('commentsMoreLabel');
    const name = tEn('commentsMoreAriaLabel', { n: 3 });
    expect(name).toContain(visibleLabel);
    expect(name).toContain('3');
  });

  // ⛔뮤테이션 대조 — AC11 자체가 지키려는 함정("aria-label이 있는가"로 세면 통과하는
  // 오탐)을 이 스위트가 실제로 잡는지 자가 증명. label을 포함 안 하는 가짜 템플릿을
  // 넣으면 위와 같은 assert 패턴이 반드시 실패해야 한다.
  it('뮤테이션 대조 — 라벨을 안 품는 접근 이름은 이 검산에서 반드시 잡힌다', () => {
    const fakeName = '3번째 댓글의 액션'; // "작업으로 전환"을 안 품음
    expect(fakeName).not.toContain('작업으로 전환');
  });

  // AC10 — 로케일 어순이 의도적으로 다른지(라벨이 통째로 붙어 있는지) 최소 1건 고정.
  it('AC10 — ko는 대상(순번)이 앞·라벨이 뒤, en은 라벨이 앞·대상(순번)이 뒤', () => {
    const ko = tKo('commentsReplyAriaLabel', { n: 5, label: '답변' });
    const en = tEn('commentsReplyAriaLabel', { n: 5, label: 'Reply' });
    expect(ko.indexOf('5')).toBeLessThan(ko.indexOf('답변'));
    expect(en.indexOf('Reply')).toBeLessThan(en.indexOf('5'));
  });
});
