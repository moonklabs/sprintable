import type { RoutingAutoReplyMode, RoutingRuleSummary } from './agent-routing-rule';

export type WorkflowMemberType = 'agent' | 'human';
export type WorkflowTemplateId = 'standard-dev' | 'review-heavy' | 'solo-dev';

export interface WorkflowMember {
  id: string;
  name: string;
  type: WorkflowMemberType;
  role?: string;
  isSynthetic?: boolean;
}

export interface WorkflowNode {
  id: string;
  memberId: string;
  x: number;
  y: number;
  locked?: boolean;
}

export interface WorkflowEdge {
  id: string;
  ruleId: string | null;
  sourceNodeId: string;
  targetNodeId: string;
  memoTypes: string[];
  action: RoutingAutoReplyMode;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowValidationIssue {
  edgeId: string;
  code: 'missing_source' | 'missing_target' | 'human_source' | 'forward_target_required' | 'self_loop';
}

export interface SerializedWorkflowRule {
  edgeId: string;
  id?: string;
  agent_id: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name: string;
  priority: number;
  match_type: 'event';
  conditions: { memo_type: string[] };
  action: { auto_reply_mode: RoutingAutoReplyMode; forward_to_agent_id: string | null };
  target_runtime: string;
  target_model: string | null;
  is_enabled: boolean;
}

export interface WorkflowRoutePreview {
  memoType: string;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  matchedAgentId: string | null;
  result: 'fallback' | 'report' | 'forward';
  steps: WorkflowMember[];
}

export interface WorkflowDiffSummary {
  hasChanges: boolean;
  addedRules: number;
  removedRules: number;
  changedRules: number;
  impactedMemoTypes: string[];
}

export const WORKFLOW_ORIGINAL_ASSIGNEE_ID = '__workflow_original_assignee__';
export const WORKFLOW_MEMO_TYPE_OPTIONS = ['memo', 'task', 'decision', 'request', 'bug', 'requirement', 'user_story', 'dev_task', 'review'] as const;
export const WORKFLOW_TEMPLATE_IDS: WorkflowTemplateId[] = ['standard-dev', 'review-heavy', 'solo-dev'];

const NODE_WIDTH = 176;
const NODE_HEIGHT = 92;

export function createOriginalAssigneeMember(): WorkflowMember {
  return {
    id: WORKFLOW_ORIGINAL_ASSIGNEE_ID,
    name: 'Original assignee',
    type: 'human',
    role: 'fallback',
    isSynthetic: true,
  };
}

export function getWorkflowMembers(members: WorkflowMember[]): WorkflowMember[] {
  const deduped = new Map<string, WorkflowMember>();
  for (const member of members) {
    deduped.set(member.id, member);
  }
  deduped.set(WORKFLOW_ORIGINAL_ASSIGNEE_ID, createOriginalAssigneeMember());
  return Array.from(deduped.values());
}

function normalizeMemoTypes(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
}

function defaultNodePosition(index: number) {
  return {
    x: 32 + (index % 3) * 220,
    y: 32 + Math.floor(index / 3) * 148,
  };
}

function createNode(memberId: string, index: number, locked = false): WorkflowNode {
  return {
    id: memberId,
    memberId,
    ...defaultNodePosition(index),
    locked,
  };
}

function createEdge(
  sourceNodeId: string,
  targetNodeId: string,
  action: RoutingAutoReplyMode,
  memoTypes: string[],
  ruleId: string | null = null,
): WorkflowEdge {
  return {
    id: `${sourceNodeId}:${targetNodeId}:${action}:${normalizeMemoTypes(memoTypes).join('-') || 'all'}`,
    ruleId,
    sourceNodeId,
    targetNodeId,
    memoTypes: normalizeMemoTypes(memoTypes),
    action,
  };
}

export function buildWorkflowGraphFromRules(
  rules: RoutingRuleSummary[],
  members: WorkflowMember[],
): WorkflowGraph {
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const orderedMemberIds: string[] = [];

  const pushMemberId = (memberId: string) => {
    if (!orderedMemberIds.includes(memberId) && memberMap.has(memberId)) {
      orderedMemberIds.push(memberId);
    }
  };

  const edges = rules
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => {
      pushMemberId(rule.agent_id);
      const targetMemberId = rule.action.auto_reply_mode === 'process_and_forward' && rule.action.forward_to_agent_id
        ? rule.action.forward_to_agent_id
        : WORKFLOW_ORIGINAL_ASSIGNEE_ID;
      pushMemberId(targetMemberId);
      return createEdge(
        rule.agent_id,
        targetMemberId,
        rule.action.auto_reply_mode,
        rule.conditions.memo_type,
        rule.id,
      );
    });

  if (edges.some((edge) => edge.targetNodeId === WORKFLOW_ORIGINAL_ASSIGNEE_ID)) {
    pushMemberId(WORKFLOW_ORIGINAL_ASSIGNEE_ID);
  }

  const nodes = orderedMemberIds.map((memberId, index) => createNode(memberId, index, memberId === WORKFLOW_ORIGINAL_ASSIGNEE_ID));
  return { nodes, edges };
}

export function buildWorkflowTemplate(templateId: WorkflowTemplateId, members: WorkflowMember[]): WorkflowGraph {
  const allMembers = getWorkflowMembers(members);
  const agents = allMembers.filter((member) => member.type === 'agent');
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  if (agents.length === 0) {
    return { nodes, edges };
  }

  const addNode = (memberId: string, locked = false) => {
    if (nodes.some((node) => node.memberId === memberId)) return;
    nodes.push(createNode(memberId, nodes.length, locked));
  };

  addNode(agents[0].id);
  addNode(WORKFLOW_ORIGINAL_ASSIGNEE_ID, true);

  switch (templateId) {
    case 'solo-dev': {
      edges.push(createEdge(agents[0].id, WORKFLOW_ORIGINAL_ASSIGNEE_ID, 'process_and_report', []));
      break;
    }
    case 'review-heavy': {
      const reviewer = agents[1] ?? agents[0];
      addNode(reviewer.id);
      if (agents[2]) addNode(agents[2].id);
      if (agents[2]) {
        edges.push(createEdge(agents[0].id, reviewer.id, 'process_and_forward', ['task', 'request']));
        edges.push(createEdge(reviewer.id, agents[2].id, 'process_and_forward', ['bug', 'decision']));
        edges.push(createEdge(agents[2].id, WORKFLOW_ORIGINAL_ASSIGNEE_ID, 'process_and_report', []));
      } else {
        edges.push(createEdge(agents[0].id, reviewer.id, 'process_and_forward', ['task', 'bug', 'request']));
        edges.push(createEdge(reviewer.id, WORKFLOW_ORIGINAL_ASSIGNEE_ID, 'process_and_report', []));
      }
      break;
    }
    case 'standard-dev':
    default: {
      const reviewer = agents[1];
      if (reviewer) {
        addNode(reviewer.id);
        edges.push(createEdge(agents[0].id, reviewer.id, 'process_and_forward', ['task', 'bug']));
        edges.push(createEdge(reviewer.id, WORKFLOW_ORIGINAL_ASSIGNEE_ID, 'process_and_report', ['decision', 'request']));
      } else {
        edges.push(createEdge(agents[0].id, WORKFLOW_ORIGINAL_ASSIGNEE_ID, 'process_and_report', []));
      }
      break;
    }
  }

  return { nodes, edges };
}

export function detectWorkflowCycles(graph: WorkflowGraph, members: WorkflowMember[]): string[] {
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const adjacency = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const sourceNode = graph.nodes.find((node) => node.id === edge.sourceNodeId);
    const targetNode = graph.nodes.find((node) => node.id === edge.targetNodeId);
    if (!sourceNode || !targetNode || edge.action !== 'process_and_forward') continue;

    const sourceMember = memberMap.get(sourceNode.memberId);
    const targetMember = memberMap.get(targetNode.memberId);
    if (!sourceMember || !targetMember) continue;
    if (sourceMember.type !== 'agent' || targetMember.type !== 'agent') continue;

    const next = adjacency.get(sourceMember.id) ?? [];
    next.push(targetMember.id);
    adjacency.set(sourceMember.id, next);
  }

  const visited = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const cycles = new Set<string>();

  const visit = (memberId: string) => {
    visited.add(memberId);
    onPath.add(memberId);
    path.push(memberId);

    for (const next of adjacency.get(memberId) ?? []) {
      if (!visited.has(next)) {
        visit(next);
        continue;
      }

      if (!onPath.has(next)) continue;
      const start = path.indexOf(next);
      if (start === -1) continue;
      const cycleIds = [...path.slice(start), next];
      const cycleLabel = cycleIds
        .map((id) => memberMap.get(id)?.name ?? id)
        .join(' → ');
      cycles.add(cycleLabel);
    }

    path.pop();
    onPath.delete(memberId);
  };

  for (const memberId of adjacency.keys()) {
    if (!visited.has(memberId)) visit(memberId);
  }

  return Array.from(cycles);
}

export function validateWorkflowGraph(graph: WorkflowGraph, members: WorkflowMember[]): WorkflowValidationIssue[] {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const issues: WorkflowValidationIssue[] = [];

  for (const edge of graph.edges) {
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    const targetNode = nodeMap.get(edge.targetNodeId);
    const sourceMember = sourceNode ? memberMap.get(sourceNode.memberId) : null;
    const targetMember = targetNode ? memberMap.get(targetNode.memberId) : null;

    if (!sourceNode || !sourceMember) {
      issues.push({ edgeId: edge.id, code: 'missing_source' });
      continue;
    }

    if (!targetNode || !targetMember) {
      issues.push({ edgeId: edge.id, code: 'missing_target' });
      continue;
    }

    if (sourceMember.type !== 'agent') {
      issues.push({ edgeId: edge.id, code: 'human_source' });
      continue;
    }

    if (edge.action === 'process_and_forward' && targetMember.type !== 'agent') {
      issues.push({ edgeId: edge.id, code: 'forward_target_required' });
      continue;
    }

    if (edge.action === 'process_and_forward' && targetMember.id === sourceMember.id) {
      issues.push({ edgeId: edge.id, code: 'self_loop' });
    }
  }

  return issues;
}

export function serializeWorkflowGraph(
  graph: WorkflowGraph,
  members: WorkflowMember[],
  existingRules: RoutingRuleSummary[] = [],
): SerializedWorkflowRule[] {
  const issues = validateWorkflowGraph(graph, members);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.code).join(','));
  }

  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const existingRuleMap = new Map(existingRules.map((rule) => [rule.id, rule]));

  return graph.edges.map((edge, index) => {
    const sourceNode = nodeMap.get(edge.sourceNodeId)!;
    const targetNode = nodeMap.get(edge.targetNodeId)!;
    const sourceMember = memberMap.get(sourceNode.memberId)!;
    const targetMember = memberMap.get(targetNode.memberId)!;
    const existingRule = edge.ruleId ? existingRuleMap.get(edge.ruleId) : null;
    const memoTypes = normalizeMemoTypes(edge.memoTypes);

    return {
      edgeId: edge.id,
      id: edge.ruleId ?? undefined,
      agent_id: sourceMember.id,
      persona_id: existingRule?.persona_id ?? null,
      deployment_id: existingRule?.deployment_id ?? null,
      name: `${sourceMember.name} → ${targetMember.name}`,
      priority: (index + 1) * 10,
      match_type: 'event',
      conditions: { memo_type: memoTypes },
      action: {
        auto_reply_mode: edge.action,
        forward_to_agent_id: edge.action === 'process_and_forward' && targetMember.type === 'agent'
          ? targetMember.id
          : null,
      },
      target_runtime: existingRule?.target_runtime ?? 'openclaw',
      target_model: existingRule?.target_model ?? null,
      // The editor draft always represents the intended live workflow.
      // Emergency disable is a temporary live guardrail, so saving from this surface
      // must re-enable the drafted rules unless/until explicit state controls exist.
      is_enabled: true,
    };
  });
}


type WorkflowRuleShape = {
  id?: string | null;
  agent_id: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name: string;
  priority: number;
  match_type: string;
  conditions: { memo_type: string[] };
  action: { auto_reply_mode: RoutingAutoReplyMode; forward_to_agent_id: string | null };
  target_runtime: string;
  target_model: string | null;
  is_enabled: boolean;
};

function createComparableWorkflowRule(rule: WorkflowRuleShape) {
  return {
    agent_id: rule.agent_id,
    persona_id: rule.persona_id ?? null,
    deployment_id: rule.deployment_id ?? null,
    name: rule.name.trim(),
    priority: rule.priority,
    match_type: rule.match_type,
    conditions: { memo_type: normalizeMemoTypes(rule.conditions.memo_type) },
    action: {
      auto_reply_mode: rule.action.auto_reply_mode,
      forward_to_agent_id: rule.action.auto_reply_mode === 'process_and_forward'
        ? rule.action.forward_to_agent_id ?? null
        : null,
    },
    target_runtime: rule.target_runtime,
    target_model: rule.target_model ?? null,
    is_enabled: rule.is_enabled,
  };
}

function findWorkflowMember(memberMap: Map<string, WorkflowMember>, memberId: string): WorkflowMember {
  return memberMap.get(memberId) ?? {
    id: memberId,
    name: memberId,
    type: memberId === WORKFLOW_ORIGINAL_ASSIGNEE_ID ? 'human' : 'agent',
  };
}

function addImpactedMemoTypes(target: Set<string>, memoTypes: string[]) {
  if (memoTypes.length === 0) {
    WORKFLOW_MEMO_TYPE_OPTIONS.forEach((memoType) => target.add(memoType));
    return;
  }

  memoTypes.forEach((memoType) => target.add(memoType));
}

export function summarizeWorkflowDiff(
  currentRules: RoutingRuleSummary[],
  draftRules: SerializedWorkflowRule[],
): WorkflowDiffSummary {
  const current = currentRules.map((rule) => createComparableWorkflowRule(rule));
  const draft = draftRules.map((rule) => createComparableWorkflowRule(rule));
  const impactedMemoTypes = new Set<string>();
  const comparableLength = Math.max(current.length, draft.length);
  let changedRules = 0;

  for (let index = 0; index < comparableLength; index += 1) {
    const previous = current[index] ?? null;
    const next = draft[index] ?? null;
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      continue;
    }

    changedRules += 1;
    if (previous) addImpactedMemoTypes(impactedMemoTypes, previous.conditions.memo_type);
    if (next) addImpactedMemoTypes(impactedMemoTypes, next.conditions.memo_type);
  }

  return {
    hasChanges: changedRules > 0,
    addedRules: Math.max(0, draft.length - current.length),
    removedRules: Math.max(0, current.length - draft.length),
    changedRules,
    impactedMemoTypes: [...impactedMemoTypes],
  };
}

export function simulateWorkflowRoute(
  rules: Array<Pick<SerializedWorkflowRule, 'id' | 'name' | 'agent_id' | 'conditions' | 'action' | 'is_enabled'>>,
  members: WorkflowMember[],
  memoType: string,
): WorkflowRoutePreview {
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const originalAssignee = findWorkflowMember(memberMap, WORKFLOW_ORIGINAL_ASSIGNEE_ID);
  const normalizedMemoType = memoType.trim().toLowerCase();
  const matchedRule = rules.find((rule) => {
    if (rule.is_enabled === false) return false;
    const memoTypes = normalizeMemoTypes(rule.conditions.memo_type);
    return memoTypes.length === 0 || memoTypes.includes(normalizedMemoType);
  }) ?? null;

  if (!matchedRule) {
    return {
      memoType: normalizedMemoType,
      matchedRuleId: null,
      matchedRuleName: null,
      matchedAgentId: null,
      result: 'fallback',
      steps: [originalAssignee],
    };
  }

  const matchedAgent = findWorkflowMember(memberMap, matchedRule.agent_id);
  if (matchedRule.action.auto_reply_mode === 'process_and_forward' && matchedRule.action.forward_to_agent_id) {
    return {
      memoType: normalizedMemoType,
      matchedRuleId: matchedRule.id ?? null,
      matchedRuleName: matchedRule.name,
      matchedAgentId: matchedRule.agent_id,
      result: 'forward',
      steps: [
        originalAssignee,
        matchedAgent,
        findWorkflowMember(memberMap, matchedRule.action.forward_to_agent_id),
      ],
    };
  }

  return {
    memoType: normalizedMemoType,
    matchedRuleId: matchedRule.id ?? null,
    matchedRuleName: matchedRule.name,
    matchedAgentId: matchedRule.agent_id,
    result: 'report',
    steps: [originalAssignee, matchedAgent, originalAssignee],
  };
}

export function buildWorkflowPreviewCatalog(
  rules: Array<Pick<SerializedWorkflowRule, 'id' | 'name' | 'agent_id' | 'conditions' | 'action' | 'is_enabled'>>,
  members: WorkflowMember[],
  memoTypes: readonly string[] = WORKFLOW_MEMO_TYPE_OPTIONS,
): WorkflowRoutePreview[] {
  return memoTypes.map((memoType) => simulateWorkflowRoute(rules, members, memoType));
}

export function getEdgeSummary(edge: WorkflowEdge, graph: WorkflowGraph, members: WorkflowMember[]) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const memberMap = new Map(getWorkflowMembers(members).map((member) => [member.id, member]));
  const sourceNode = nodeMap.get(edge.sourceNodeId);
  const targetNode = nodeMap.get(edge.targetNodeId);
  return {
    source: sourceNode ? memberMap.get(sourceNode.memberId) ?? null : null,
    target: targetNode ? memberMap.get(targetNode.memberId) ?? null : null,
    memoTypes: normalizeMemoTypes(edge.memoTypes),
  };
}

export function getNodeCenter(node: WorkflowNode) {
  return {
    x: node.x + NODE_WIDTH / 2,
    y: node.y + NODE_HEIGHT / 2,
  };
}

export function getNodeSize() {
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}
