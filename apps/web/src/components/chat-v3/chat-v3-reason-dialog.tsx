'use client';

import type { ComponentProps } from 'react';
import { TodayV3ReasonDialog } from '@/components/today-v3/today-v3-reason-dialog';

/**
 * story #3972 — 「변경 요청」 사유 입력. 원래 `today-v3-reason-dialog.tsx`를 파일째 복제했었다(당시 base에 그 디렉터리가 없어서 ·
 * «착지 뒤 rebase 1회»로 남은 사본). story #4370 — 사유 초안(닫혀도 유지 · «취소» · 성공만 지움)을 두 벌로 짜지 않게 사본을 걷고
 * 같은 창을 테스트 id 앞머리만 바꿔 쓴다.
 */
export function ChatV3ReasonDialog(props: Omit<ComponentProps<typeof TodayV3ReasonDialog>, 'testIdPrefix'>) {
  return <TodayV3ReasonDialog {...props} testIdPrefix="chat-v3" />;
}
