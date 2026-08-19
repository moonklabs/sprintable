import { describe, expect, it } from 'vitest';
import { cyclicStages, isCyclicDefinition, type EventDefinitionResponse } from './loop-create-dialog';

// story #2792(2790 P1) — workflow-recipes → event_definitions 전환. 서버가 kind 필드를
// 안 내려주므로 클라 판별(payload_schema.properties.stage.enum 존재)이 유일한 사이클형
// 필터 축이다 — 이 판별이 틀리면 signal/measurement 정의가 select에 섞이거나, 진짜
// 사이클형 레시피가 걸러진다.

const CYCLIC: EventDefinitionResponse = {
  id: '1', key: 'preset.workflow.scrum_3step', org_id: null,
  name: '3단계 스크럼', description: '기획 → 개발 → QA 3단계 워크플로우.',
  payload_schema: {
    properties: { stage: { enum: ['kickoff', 'implementation', 'qa_review'] } },
  },
  stage_metadata: {
    kickoff: { role: 'PO', action: '기능 명세 및 AC 작성' },
    implementation: { role: 'Dev', action: '코드 작성 및 PR 제출' },
    qa_review: { role: 'QA', action: 'AC 체크리스트 검증 후 APPROVE/REJECT' },
  },
};

const SIGNAL: EventDefinitionResponse = {
  id: '2', key: 'org.acme.deploy_started', org_id: 'org-acme',
  name: '배포 시작', description: null,
  payload_schema: { properties: {} },
  stage_metadata: {},
};

const NO_PROPERTIES: EventDefinitionResponse = {
  id: '3', key: 'preset.legacy.malformed', org_id: null,
  name: '스키마 없음', description: null,
  payload_schema: {},
  stage_metadata: {},
};

describe('cyclicStages / isCyclicDefinition (story #2792)', () => {
  it('사이클형 정의는 payload_schema.properties.stage.enum 순서 그대로 stage 목록을 낸다', () => {
    expect(cyclicStages(CYCLIC)).toEqual(['kickoff', 'implementation', 'qa_review']);
    expect(isCyclicDefinition(CYCLIC)).toBe(true);
  });

  it('signal/measurement류(stage 없음)는 사이클형이 아니다', () => {
    expect(cyclicStages(SIGNAL)).toEqual([]);
    expect(isCyclicDefinition(SIGNAL)).toBe(false);
  });

  it('properties 자체가 없는 방어적 케이스도 크래시 없이 빈 배열로 떨어진다', () => {
    expect(cyclicStages(NO_PROPERTIES)).toEqual([]);
    expect(isCyclicDefinition(NO_PROPERTIES)).toBe(false);
  });
});
