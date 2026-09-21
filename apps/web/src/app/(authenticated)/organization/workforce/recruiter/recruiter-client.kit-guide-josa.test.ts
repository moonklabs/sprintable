// story #4120(PO 실측, 2026-09-21) — kitOrientingGuideBody/guideFileDeliveryNoteMcp/
// guideFileDeliveryNoteConnector의 「{filename}을(를)」·「{promptFile}은(는)」 고정 조사를
// pickEulReulJosa/pickEunNeunJosa로. 이 세 자리의 실 값(KIT_FILENAME·prompt_file 5종)은
// 전부 영문 ".md" 끝(받침 개념 없음, safe fallback)이라 실사용 값은 항상 받침 없는
// 갈래 하나뿐이다 — 그 실값 그대로와, 헬퍼가 일반적으로도 맞게 배선됐는지 보여주는
// 받침 있는 합성값을 함께 고정한다(전체 위저드 마운트는 무거워 이 파일의 ConnectCliBody
// 선례처럼 messages 템플릿을 createTranslator로 직접 검증 — comments-action-aria-labels.
// test.ts와 동일 방법론).
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { pickEulReulJosa, pickEunNeunJosa } from '@/lib/korean-particle';
import { KIT_FILENAME } from '@/services/recruit';
import koMessages from '../../../../../../messages/ko.json';

const t = createTranslator({ locale: 'ko', messages: koMessages, namespace: 'recruiter' });

describe('kitOrientingGuideBody — 조사(story #4120)', () => {
  it('실값(KIT_FILENAME=SPRINTABLE_ONBOARDING.md, 영문 끝 → 받침 없음) → «를»', () => {
    expect(t('kitOrientingGuideBody', { filename: KIT_FILENAME, josa: pickEulReulJosa(KIT_FILENAME) }))
      .toBe(`${KIT_FILENAME}를 에이전트에게 전달`);
  });

  it('받침 있는 합성 파일명 → «을»(헬퍼 일반 배선 확認)', () => {
    const filename = '가이드북'; // 북=ㄱ받침
    expect(t('kitOrientingGuideBody', { filename, josa: pickEulReulJosa(filename) }))
      .toBe('가이드북을 에이전트에게 전달');
  });
});

describe('guideFileDeliveryNoteMcp/Connector — 조사 2자리(story #4120)', () => {
  it('실값(filename=KIT_FILENAME·promptFile="CLAUDE.md", 둘 다 영문 끝) → 둘 다 받침 없음', () => {
    const filename = KIT_FILENAME;
    const promptFile = 'CLAUDE.md';
    const out = t('guideFileDeliveryNoteMcp', {
      filename, promptFile,
      josa: pickEulReulJosa(filename),
      promptJosa: pickEunNeunJosa(promptFile),
    });
    expect(out).toBe(`${filename}를 작업 폴더에 두고 에이전트에게 '읽고 따르라'고 지시하세요 — 기존 ${promptFile}는 그대로 둬요.`);
    expect(out).not.toContain('을(를)');
    expect(out).not.toContain('은(는)');
  });

  it('guideFileDeliveryNoteConnector 실값 → «를»', () => {
    const filename = KIT_FILENAME;
    expect(t('guideFileDeliveryNoteConnector', { filename, josa: pickEulReulJosa(filename) }))
      .toBe(`수동 연결 설정을 완료한 후 ${filename}를 에이전트에게 전달하세요.`);
  });
});
