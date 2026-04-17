import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_ORIGINAL_ASSIGNEE_ID,
  buildWorkflowGraphFromRules,
  buildWorkflowPreviewCatalog,
  buildWorkflowTemplate,
  detectWorkflowCycles,
  serializeWorkflowGraph,
  simulateWorkflowRoute,
  summarizeWorkflowDiff,
  validateWorkflowGraph,
  type WorkflowGraph,
  type WorkflowMember,
} from './agent-workflow-editor';
import type { RoutingRuleSummary } from './agent-routing-rule';

const members: WorkflowMember[] = [
  { id: 'agent-1', name: 'Didi', type: 'agent' },
  { id: 'agent-2', name: 'Qasim', type: 'agent' },
  { id: 'agent-3', name: 'Ortega', type: 'agent' },
  { id: 'human-1', name: 'Paulo', type: 'human' },
];

describe('buildWorkflowTemplate', () => {
  it('creates a review-heavy workflow with chained agent forwarding and final report', () => {
    const graph = buildWorkflowTemplate('review-heavy', members);

    expect(graph.nodes.map((node) => node.memberId)).toEqual([
      'agent-1',
      WORKFLOW_ORIGINAL_ASSIGNEE_ID,
      'agent-2',
      'agent-3',
    ]);
    expect(graph.edges).toEqual([
      expect.objectContaining({ sourceNodeId: 'agent-1', targetNodeId: 'agent-2', action: 'process_and_forward', memoTypes: ['task', 'request'] }),
      expect.objectContaining({ sourceNodeId: 'agent-2', targetNodeId: 'agent-3', action: 'process_and_forward', memoTypes: ['bug', 'decision'] }),
      expect.objectContaining({ sourceNodeId: 'agent-3', targetNodeId: WORKFLOW_ORIGINAL_ASSIGNEE_ID, action: 'process_and_report', memoTypes: [] }),
    ]);
  });
});

describe('detectWorkflowCycles', () => {
  it('warns when agent-to-agent forwarding creates a cycle', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
        { id: 'agent-2', memberId: 'agent-2', x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: null, sourceNodeId: 'agent-1', targetNodeId: 'agent-2', action: 'process_and_forward', memoTypes: ['task'] },
        { id: 'edge-2', ruleId: null, sourceNodeId: 'agent-2', targetNodeId: 'agent-1', action: 'process_and_forward', memoTypes: ['task'] },
      ],
    };

    expect(detectWorkflowCycles(graph, members)).toEqual(['Didi → Qasim → Didi']);
  });
});

describe('serializeWorkflowGraph', () => {
  it('serializes valid agent review chains with explicit forward targets', () => {
    const existingRules: RoutingRuleSummary[] = [{
      id: 'rule-1',
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      persona_id: 'persona-1',
      deployment_id: 'deployment-1',
      name: 'old',
      priority: 10,
      match_type: 'event',
      conditions: { memo_type: ['task'] },
      action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
      target_runtime: 'openclaw',
      target_model: 'gpt-5',
      is_enabled: true,
      metadata: {},
      created_by: 'member-1',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:00.000Z',
    }];
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
        { id: 'agent-2', memberId: 'agent-2', x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: 'rule-1', sourceNodeId: 'agent-1', targetNodeId: 'agent-2', action: 'process_and_forward', memoTypes: ['Task', 'task', 'bug'] },
      ],
    };

    expect(serializeWorkflowGraph(graph, members, existingRules)).toEqual([
      {
        edgeId: 'edge-1',
        id: 'rule-1',
        agent_id: 'agent-1',
        persona_id: 'persona-1',
        deployment_id: 'deployment-1',
        name: 'Didi → Qasim',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task', 'bug'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        target_runtime: 'openclaw',
        target_model: 'gpt-5',
        is_enabled: true,
      },
    ]);
  });

  it('re-enables an emergency-disabled rule when the workflow is saved again', () => {
    const existingRules: RoutingRuleSummary[] = [{
      id: 'rule-1',
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      persona_id: 'persona-1',
      deployment_id: 'deployment-1',
      name: 'disabled-live-rule',
      priority: 10,
      match_type: 'event',
      conditions: { memo_type: ['task'] },
      action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
      target_runtime: 'openclaw',
      target_model: 'gpt-5',
      is_enabled: false,
      metadata: {},
      created_by: 'member-1',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:00.000Z',
    }];
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
        { id: WORKFLOW_ORIGINAL_ASSIGNEE_ID, memberId: WORKFLOW_ORIGINAL_ASSIGNEE_ID, x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: 'rule-1', sourceNodeId: 'agent-1', targetNodeId: WORKFLOW_ORIGINAL_ASSIGNEE_ID, action: 'process_and_report', memoTypes: ['task', 'bug'] },
      ],
    };

    expect(serializeWorkflowGraph(graph, members, existingRules)).toEqual([
      {
        edgeId: 'edge-1',
        id: 'rule-1',
        agent_id: 'agent-1',
        persona_id: 'persona-1',
        deployment_id: 'deployment-1',
        name: 'Didi → Original assignee',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task', 'bug'] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: 'gpt-5',
        is_enabled: true,
      },
    ]);
  });

  it('flags human-source edges as invalid save payloads', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'human-1', memberId: 'human-1', x: 0, y: 0 },
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: null, sourceNodeId: 'human-1', targetNodeId: 'agent-1', action: 'process_and_forward', memoTypes: [] },
      ],
    };

    expect(validateWorkflowGraph(graph, members)).toEqual([{ edgeId: 'edge-1', code: 'human_source' }]);
    expect(() => serializeWorkflowGraph(graph, members)).toThrow('human_source');
  });

  it('flags review edges that try to forward without another agent target', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
        { id: WORKFLOW_ORIGINAL_ASSIGNEE_ID, memberId: WORKFLOW_ORIGINAL_ASSIGNEE_ID, x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: null, sourceNodeId: 'agent-1', targetNodeId: WORKFLOW_ORIGINAL_ASSIGNEE_ID, action: 'process_and_forward', memoTypes: ['task'] },
      ],
    };

    expect(validateWorkflowGraph(graph, members)).toEqual([{ edgeId: 'edge-1', code: 'forward_target_required' }]);
    expect(() => serializeWorkflowGraph(graph, members)).toThrow('forward_target_required');
  });

  it('flags self-loop review edges as invalid save payloads', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'agent-1', memberId: 'agent-1', x: 0, y: 0 },
      ],
      edges: [
        { id: 'edge-1', ruleId: null, sourceNodeId: 'agent-1', targetNodeId: 'agent-1', action: 'process_and_forward', memoTypes: ['task'] },
      ],
    };

    expect(validateWorkflowGraph(graph, members)).toEqual([{ edgeId: 'edge-1', code: 'self_loop' }]);
    expect(() => serializeWorkflowGraph(graph, members)).toThrow('self_loop');
  });
});


describe('workflow rollout previews', () => {
  it('simulates the real forward handoff path before rollout', () => {
    const preview = simulateWorkflowRoute([
      {
        id: 'rule-1',
        agent_id: 'agent-1',
        name: 'Didi → Qasim',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        is_enabled: true,
      },
    ], members, 'task');

    expect(preview.result).toBe('forward');
    expect(preview.steps.map((step) => step.id)).toEqual([
      WORKFLOW_ORIGINAL_ASSIGNEE_ID,
      'agent-1',
      'agent-2',
    ]);
  });

  it('builds an expected-path catalog for every memo type lane', () => {
    const previews = buildWorkflowPreviewCatalog([
      {
        id: 'rule-1',
        agent_id: 'agent-1',
        name: 'match-all',
        conditions: { memo_type: [] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        is_enabled: true,
      },
    ], members, ['task', 'bug']);

    expect(previews).toEqual([
      expect.objectContaining({ memoType: 'task', result: 'report' }),
      expect.objectContaining({ memoType: 'bug', result: 'report' }),
    ]);
  });

  it('summarizes impacted memo types when draft rollout changes the live route', () => {
    const summary = summarizeWorkflowDiff([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'Didi → Original',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-09T00:00:00.000Z',
        updated_at: '2026-04-09T00:00:00.000Z',
      },
    ], [
      {
        edgeId: 'edge-1',
        id: 'rule-1',
        agent_id: 'agent-2',
        persona_id: null,
        deployment_id: null,
        name: 'Qasim → Original',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task', 'bug'] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
      },
    ]);

    expect(summary).toEqual({
      hasChanges: true,
      addedRules: 0,
      removedRules: 0,
      changedRules: 1,
      impactedMemoTypes: ['task', 'bug'],
    });
  });

  it('treats an emergency-disabled live rule as a recoverable draft change', () => {
    const summary = summarizeWorkflowDiff([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'Didi → Original',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: false,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-09T00:00:00.000Z',
        updated_at: '2026-04-09T00:00:00.000Z',
      },
    ], [
      {
        edgeId: 'edge-1',
        id: 'rule-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'Didi → Original',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
      },
    ]);

    expect(summary).toEqual({
      hasChanges: true,
      addedRules: 0,
      removedRules: 0,
      changedRules: 1,
      impactedMemoTypes: ['task'],
    });
  });
});

describe('buildWorkflowGraphFromRules', () => {
  it('maps report-only rules back to the synthetic original assignee node', () => {
    const graph = buildWorkflowGraphFromRules([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'report',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: [] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-09T00:00:00.000Z',
        updated_at: '2026-04-09T00:00:00.000Z',
      },
    ], members);

    expect(graph.nodes.some((node) => node.memberId === WORKFLOW_ORIGINAL_ASSIGNEE_ID)).toBe(true);
    expect(graph.edges).toEqual([
      expect.objectContaining({ ruleId: 'rule-1', sourceNodeId: 'agent-1', targetNodeId: WORKFLOW_ORIGINAL_ASSIGNEE_ID }),
    ]);
  });
});
