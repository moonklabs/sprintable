// story #4174 후속 — preset.marketing.blog_article 플랫폼 정의(alembic 0399 시드 + 0401의 `pending_approval.approval`)를
// 문자 그대로 옮긴 한 벌. 영상 레시피 fixture(video-production-seed.test.fixture.ts)와 같은 이유 — 테스트가 스스로 지어낸
// role·stage 모양과만 맞춰지는 함정(#4426)을 막는다. 시드가 바뀌면 이 파일도 같이 바꾼다.
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';

export const BLOG_ARTICLE_FLOW = [
  'planning', 'concept_confirmed', 'writing', 'verification', 'pending_approval', 'published', 'publish_checked',
] as const;

export const BLOG_ARTICLE_RECIPE: EventDefinitionResponse & { id: string } = {
  id: '7b1d7c4e-4174-4f0a-9c55-0399b10aa000',
  key: 'preset.marketing.blog_article',
  org_id: null,
  name: '블로그 글',
  description: '기획부터 발행 확인까지 7단계예요. 기획과 발행 두 곳만 사람이 승인하고, 나머지는 에이전트가 진행해요.',
  payload_schema: { properties: { stage: { enum: [...BLOG_ARTICLE_FLOW] } } },
  stage_metadata: {
    planning: { role: 'Creator', action: '주제·키워드 기획(제목 후보와 글 구성)' },
    concept_confirmed: {
      role: 'Director', action: '컨셉 승인(주제·키워드·구성 확인)',
      gate: { type: 'concept_approval', approver: 'org_owner' },
    },
    writing: { role: 'Creator', action: '블로그 초안 작성', capability: { kind: 'draft_site_post' } },
    verification: { role: 'Creator', action: '콘텐츠 규칙 검수 후 초안 제출', capability: { kind: 'submit_site_post' } },
    pending_approval: {
      role: 'Director', action: '제출한 초안이 발행 승인을 받을 때까지 기다리기(승인은 결재함의 초안에서)',
      approval: { surface: 'draft_gate' },
    },
    published: { role: 'Publisher', action: '승인된 초안을 블로그에 자동 발행(에이전트 할 일 없음)', capability: { kind: 'site_post_auto_publish' } },
    publish_checked: { role: 'Publisher', action: '공개 주소로 발행 결과 확인' },
  },
  role_actor_kinds: { Creator: 'agent', Director: 'human', Publisher: 'agent' },
  enabled: true,
};
