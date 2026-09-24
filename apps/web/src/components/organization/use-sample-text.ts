'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { sampleValueKind, type SampleText } from './event-definer-logic';

/** story #4257 — 미리보기 예시값 문구(로케일). 뜻을 아는 필드(sampleValueKind)는 자기 문구, 그 밖은 «예시 {name}» / «Sample {name}».
 * 정의 요약 · 정의 만들기 · 이벤트 페이지(테스트 발행)가 이 훅 하나를 쓴다. */
export function useSampleText(): SampleText {
  const t = useTranslations('organization');
  return useMemo<SampleText>(() => (name) => {
    switch (sampleValueKind(name)) {
      case 'summary': return t('definerSampleSummary');
      case 'source': return t('definerSampleSource');
      case 'member': return t('definerSampleMemberId');
      default: return t('definerSampleValue', { name });
    }
  }, [t]);
}
