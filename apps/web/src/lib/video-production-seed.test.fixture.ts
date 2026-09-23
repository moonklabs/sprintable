// story #4173 — preset.marketing.video_production 실 정의(dev GET /api/v2/events/definitions,
// version 8, 2026-09-23 실측) 문자 그대로. stage_metadata 키 순서도 API 응답 그대로(흐름 순서
// 아님 — 흐름은 payload_schema enum). 테스트가 스스로 지어낸 role 값과만 맞춰지는 함정
// (#4426 [합성표본=구조숨김])을 막기 위해, 레시피 관련 테스트는 이 한 벌을 공유한다.
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';

export const VIDEO_PRODUCTION_FLOW = [
  'draft', 'concept_confirmed', 'animatic', 'structure_passed', 'live_generation',
  'verification', 'editing', 'pending_approval', 'published',
] as const;

export const VIDEO_PRODUCTION_RECIPE: EventDefinitionResponse & { id: string } = {
  id: '2df00c8d-81cf-47cd-8c79-f91709f89ac6',
  key: 'preset.marketing.video_production',
  org_id: null,
  name: '영상 제작(릴스·쇼츠)',
  description: 'BYOA 영상 제작 레시피 1호 — 소재 수집부터 발행까지 9단계, 사람 게이트 4곳(컨셉·구조·실탄예산·최종발행)만 사람이 딸깍하고 나머지 전이는 에이전트가 진행.',
  payload_schema: { properties: { stage: { enum: [...VIDEO_PRODUCTION_FLOW] } } },
  stage_metadata: {
    draft: { role: 'Creator', action: '로그라인·매핑표·컨셉 초안 작성' },
    editing: { role: 'Creator', action: '편집 통일 패스(그레이드·룸톤·자막 레벨 통일)', capability: { kind: 'attach_video' } },
    animatic: { role: 'Creator', action: '무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청', gate: { type: 'structure_approval', approver: 'org_owner' } },
    published: { role: 'Publisher', action: '승인된 채널에 실 게시', capability: { kind: 'publish', target: 'channel_connection' } },
    verification: { role: 'Creator', action: '프레임8+받아쓰기 등 눈·귀 검증 시트 작성', capability: { kind: 'attach_video' } },
    live_generation: { role: 'Compute', action: '실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출', capability: { kind: 'generate', target: 'generation_connector' } },
    pending_approval: { role: 'Director', action: '최종 발행 승인(외부 발행 직전)', gate: { type: 'external_publish', approver: 'org_owner' } },
    structure_passed: { role: 'Director', action: '구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인', gate: { type: 'generation_budget', approver: 'org_owner' } },
    concept_confirmed: { role: 'Director', action: '우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인', gate: { type: 'concept_approval', approver: 'org_owner' } },
  },
  role_actor_kinds: { Compute: 'agent', Creator: 'agent', Director: 'human', Publisher: 'agent' },
  enabled: true,
};
