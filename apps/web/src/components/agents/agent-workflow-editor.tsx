'use client';

import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type Connection,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDown, ArrowUp, Ban, Bot, ClipboardCheck,
  Route, Save, ShieldCheck, Smartphone, Trash2, TriangleAlert, User, RotateCcw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { getRollbackSnapshotFromRules, type RoutingRuleSummary, type WorkflowVersionSummary } from '@/services/agent-routing-rule';
import { createBrowserClient } from '@/lib/db/client';
import {
  WORKFLOW_MEMO_TYPE_OPTIONS,
  WORKFLOW_ORIGINAL_ASSIGNEE_ID,
  buildWorkflowGraphFromRules,
  buildWorkflowPreviewCatalog,
  buildWorkflowTemplate,
  detectWorkflowCycles,
  getEdgeSummary,
  getWorkflowMembers,
  serializeWorkflowGraph,
  simulateWorkflowRoute,
  summarizeWorkflowDiff,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowMember,
  type WorkflowNode,
  type WorkflowTemplateId,
} from '@/services/agent-workflow-editor';

// ─── Types ────────────────────────────────────────────────────────────────────

type WFNodeData = {
  member: WorkflowMember;
  locked: boolean;
  onRemove: (nodeId: string) => void;
};

type WFRFNode = Node<WFNodeData>;
type WFEdgeData = WorkflowEdge & Record<string, unknown>;
type WFRFEdge = Edge<WFEdgeData>;

// ─── Custom Node ──────────────────────────────────────────────────────────────

function WorkflowNodeComponent({ id, data }: NodeProps<WFRFNode>) {
  const { member, locked, onRemove } = data;
  const isAgent = member.type === 'agent';

  return (
    <div className={`w-44 rounded-md border border-border bg-card px-4 py-3 shadow-md ${!locked ? 'cursor-grab active:cursor-grabbing' : ''}`}>
      <Handle
        type="target"
        position={Position.Top}
        className="!border-primary/50 !bg-primary/20"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isAgent ? <Bot className="size-4 shrink-0 text-primary" /> : <User className="size-4 shrink-0 text-emerald-500" />}
            <p className="truncate text-sm font-semibold text-foreground">
              {member.isSynthetic ? 'Original assignee' : member.name}
            </p>
          </div>
          <p className="mt-2 truncate text-xs text-muted-foreground">
            {member.isSynthetic ? 'Fallback target' : (member.role ?? (isAgent ? 'Agent' : 'Human'))}
          </p>
        </div>
        {!locked ? (
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={(event) => { event.stopPropagation(); onRemove(id); }}
          >
            <Trash2 className="size-4" />
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
        <Badge variant={isAgent ? 'info' : 'chip'}>{isAgent ? 'Agent' : 'Human'}</Badge>
        <p className="text-[10px] text-muted-foreground">drag handle to connect</p>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!border-primary/50 !bg-primary/20"
      />
    </div>
  );
}

// ─── Custom Edge ──────────────────────────────────────────────────────────────

function WorkflowEdgeComponent({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<WFRFEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const wfEdge = data as WorkflowEdge | undefined;
  const memoLabel = wfEdge?.memoTypes && wfEdge.memoTypes.length > 0
    ? wfEdge.memoTypes.join(', ')
    : 'all';
  const edgeIndex = id;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? '#7c3aed' : '#94a3b8',
          strokeWidth: selected ? 3 : 2,
        }}
        markerEnd={selected ? 'url(#workflow-arrow-selected)' : 'url(#workflow-arrow)'}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className={`nodrag nopan cursor-pointer rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            selected
              ? 'border-primary bg-primary/20 text-primary'
              : 'border-border bg-muted/80 text-muted-foreground'
          }`}
          data-edge-id={edgeIndex}
        >
          {memoLabel}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { 'workflow-node': WorkflowNodeComponent };
const edgeTypes = { 'workflow-edge': WorkflowEdgeComponent };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createLocalEdgeId() {
  return `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseApiError(payload: unknown) {
  if (!payload || typeof payload !== 'object') return 'Unknown error';
  const record = payload as { error?: { message?: string } };
  return record.error?.message ?? 'Unknown error';
}

function createWorkflowGraphFingerprint(graph: WorkflowGraph) {
  return JSON.stringify({
    nodes: graph.nodes
      .map((node) => ({ id: node.id, memberId: node.memberId, locked: node.locked === true }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges
      .map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        action: edge.action,
        memoTypes: [...edge.memoTypes].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function wfNodesToRF(
  wfNodes: WorkflowNode[],
  memberMap: Map<string, WorkflowMember>,
  fallbackMember: WorkflowMember,
  onRemove: (nodeId: string) => void,
): WFRFNode[] {
  return wfNodes.map((node) => ({
    id: node.id,
    type: 'workflow-node',
    position: { x: node.x, y: node.y },
    draggable: !node.locked,
    data: {
      member: memberMap.get(node.memberId) ?? fallbackMember,
      locked: node.locked ?? false,
      onRemove,
    },
  }));
}

function wfEdgesToRF(wfEdges: WorkflowEdge[], selectedEdgeId: string | null): WFRFEdge[] {
  return wfEdges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: 'workflow-edge',
    selected: edge.id === selectedEdgeId,
    data: edge as WFEdgeData,
  }));
}

function rfNodesToWF(rfNodes: WFRFNode[]): WorkflowNode[] {
  return rfNodes.map((node) => ({
    id: node.id,
    memberId: node.data.member.id,
    x: node.position.x,
    y: node.position.y,
    locked: node.data.locked,
  }));
}

function rfEdgesToWF(rfEdges: WFRFEdge[]): WorkflowEdge[] {
  return rfEdges.map((e) => ({
    ...(e.data as WorkflowEdge),
    sourceNodeId: e.source,
    targetNodeId: e.target,
  }));
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface AgentWorkflowEditorProps {
  initialMembers: WorkflowMember[];
  initialRules: RoutingRuleSummary[];
  projectName: string;
}

interface ApiResponse<T> {
  data: T;
  error: null | { code: string; message: string };
}

const EDGE_DATA_MIME = 'application/x-sprintable-workflow-member';
const NODE_WIDTH = 176;

// ─── Main Component ───────────────────────────────────────────────────────────

function AgentWorkflowEditorInner({ initialMembers, initialRules, projectName }: AgentWorkflowEditorProps) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const { toasts, addToast, dismissToast } = useToast();

  const members = useMemo(() => getWorkflowMembers(initialMembers), [initialMembers]);
  const fallbackMember = useMemo(
    () => members.find((member) => member.id === WORKFLOW_ORIGINAL_ASSIGNEE_ID)!,
    [members],
  );
  const agentMembers = useMemo(() => members.filter((member) => member.type === 'agent'), [members]);
  const humanMembers = useMemo(
    () => members.filter((member) => member.type === 'human' && !member.isSynthetic),
    [members],
  );
  const memberMap = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  const initialGraph = useMemo(
    () => buildWorkflowGraphFromRules(initialRules, members),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(
    () => initialGraph.edges[0]?.id ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [savedRules, setSavedRules] = useState(initialRules);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(null);
  const [dryRunMemoType, setDryRunMemoType] = useState<(typeof WORKFLOW_MEMO_TYPE_OPTIONS)[number]>('task');
  const [dryRunSurface, setDryRunSurface] = useState<'draft' | 'live'>('draft');
  const [rolloutChecklist, setRolloutChecklist] = useState({
    dryRun: false,
    expectedPaths: false,
    recoveryPlan: false,
  });

  // ─── RF state ──────────────────────────────────────────────────────────────

  const removeNode = useCallback((nodeId: string) => {
    if (nodeId === WORKFLOW_ORIGINAL_ASSIGNEE_ID) return;
    setRfNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setRfEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedEdgeId((prev) => {
      const edge = prev ? undefined : undefined; // clear if affected
      void edge;
      return null;
    });
  }, []);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<WFRFNode>(
    wfNodesToRF(initialGraph.nodes, memberMap, fallbackMember, removeNode),
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<WFRFEdge>(
    wfEdgesToRF(initialGraph.edges, initialGraph.edges[0]?.id ?? null),
  );

  // Sync onRemove callback into node data whenever removeNode changes
  useEffect(() => {
    setRfNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, onRemove: removeNode } })));
  }, [removeNode, setRfNodes]);

  // ─── Derived state ─────────────────────────────────────────────────────────

  const graph = useMemo<WorkflowGraph>(() => ({
    nodes: rfNodesToWF(rfNodes),
    edges: rfEdgesToWF(rfEdges),
  }), [rfNodes, rfEdges]);

  const selectedEdge = useMemo(
    () => graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  );
  const selectedEdgeSummary = useMemo(
    () => (selectedEdge ? getEdgeSummary(selectedEdge, graph, members) : null),
    [selectedEdge, graph, members],
  );
  const cycleWarnings = useMemo(() => detectWorkflowCycles(graph, members), [graph, members]);
  const liveGraph = useMemo(() => buildWorkflowGraphFromRules(savedRules, members), [savedRules, members]);
  const hasDraftChanges = useMemo(
    () => createWorkflowGraphFingerprint(graph) !== createWorkflowGraphFingerprint(liveGraph),
    [graph, liveGraph],
  );
  const draftWorkflow = useMemo(() => {
    try {
      return { rules: serializeWorkflowGraph(graph, members, savedRules), error: null };
    } catch (error) {
      return { rules: null, error: error instanceof Error ? error.message : 'workflow_invalid' };
    }
  }, [graph, members, savedRules]);
  const workflowDiff = useMemo(
    () => (draftWorkflow.rules ? summarizeWorkflowDiff(savedRules, draftWorkflow.rules) : {
      hasChanges: hasDraftChanges, addedRules: 0, removedRules: 0, changedRules: 0, impactedMemoTypes: [],
    }),
    [draftWorkflow.rules, hasDraftChanges, savedRules],
  );
  const livePreviewCatalog = useMemo(() => buildWorkflowPreviewCatalog(savedRules, members), [savedRules, members]);
  const draftPreviewCatalog = useMemo(
    () => (draftWorkflow.rules ? buildWorkflowPreviewCatalog(draftWorkflow.rules, members) : []),
    [draftWorkflow.rules, members],
  );
  const livePreviewMap = useMemo(() => new Map(livePreviewCatalog.map((p) => [p.memoType, p])), [livePreviewCatalog]);
  const draftPreviewMap = useMemo(() => new Map(draftPreviewCatalog.map((p) => [p.memoType, p])), [draftPreviewCatalog]);
  const visiblePreviewMemoTypes = useMemo(() => {
    if (workflowDiff.impactedMemoTypes.length === 0) return [...WORKFLOW_MEMO_TYPE_OPTIONS];
    return WORKFLOW_MEMO_TYPE_OPTIONS.filter((mt) => workflowDiff.impactedMemoTypes.includes(mt));
  }, [workflowDiff.impactedMemoTypes]);
  const activeDryRunPreview = useMemo(() => {
    if (dryRunSurface === 'draft' && draftWorkflow.rules) {
      return simulateWorkflowRoute(draftWorkflow.rules, members, dryRunMemoType);
    }
    return livePreviewMap.get(dryRunMemoType) ?? simulateWorkflowRoute(savedRules, members, dryRunMemoType);
  }, [draftWorkflow.rules, dryRunMemoType, dryRunSurface, livePreviewMap, members, savedRules]);
  const rollbackSnapshot = useMemo(() => getRollbackSnapshotFromRules(savedRules), [savedRules]);
  const rolloutChecklistComplete = rolloutChecklist.dryRun && rolloutChecklist.expectedPaths && rolloutChecklist.recoveryPlan;
  const canRollout = hasDraftChanges && !draftWorkflow.error && rolloutChecklistComplete && !saving;

  const memoTypeLabels = useMemo(() => ({
    memo: t('workflowMemoTypeMemo'),
    task: t('workflowMemoTypeTask'),
    decision: t('workflowMemoTypeDecision'),
    request: t('workflowMemoTypeRequest'),
    bug: t('workflowMemoTypeBug'),
    requirement: t('workflowMemoTypeRequirement'),
    user_story: t('workflowMemoTypeUserStory'),
    dev_task: t('workflowMemoTypeDevTask'),
    review: t('workflowMemoTypeReview'),
  }), [t]);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const getMemberLabel = useCallback((member: WorkflowMember | null | undefined) => {
    if (!member) return '';
    return member.isSynthetic ? t('workflowOriginalAssignee') : member.name;
  }, [t]);

  const formatMemoTypes = useCallback((memoTypes: string[]) => {
    if (memoTypes.length === 0) return t('workflowAllMemoTypes');
    return memoTypes.map((mt) => memoTypeLabels[mt as keyof typeof memoTypeLabels] ?? mt).join(', ');
  }, [memoTypeLabels, t]);

  const getActionLabel = useCallback((action: WorkflowEdge['action']) => {
    return action === 'process_and_forward' ? t('workflowActionForward') : t('workflowActionReport');
  }, [t]);

  const formatPreviewPath = useCallback((steps: WorkflowMember[]) => steps.map((s) => getMemberLabel(s)).join(' → '), [getMemberLabel]);
  const getPreviewOutcomeLabel = useCallback((result: 'fallback' | 'report' | 'forward') => {
    if (result === 'forward') return t('workflowDryRunOutcomeForward');
    if (result === 'report') return t('workflowDryRunOutcomeReport');
    return t('workflowDryRunOutcomeFallback');
  }, [t]);

  // ─── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visiblePreviewMemoTypes.includes(dryRunMemoType)) {
      setDryRunMemoType(visiblePreviewMemoTypes[0] ?? 'task');
    }
  }, [dryRunMemoType, visiblePreviewMemoTypes]);

  useEffect(() => {
    if (!hasDraftChanges) setDryRunSurface('live');
  }, [hasDraftChanges]);

  useEffect(() => {
    setRolloutChecklist({ dryRun: false, expectedPaths: false, recoveryPlan: false });
  }, [hasDraftChanges, draftWorkflow.error, workflowDiff.changedRules]);

  // ─── Canvas actions ────────────────────────────────────────────────────────

  const focusEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setRfEdges((prev) => prev.map((e) => ({ ...e, selected: e.id === edgeId })));
  }, [setRfEdges]);

  const addMemberNode = useCallback((memberId: string, x?: number, y?: number) => {
    const member = memberMap.get(memberId);
    if (!member) return;

    const existing = rfNodes.find((n) => n.id === memberId);
    if (existing) {
      if (typeof x === 'number' && typeof y === 'number') {
        setRfNodes((prev) => prev.map((n) => n.id === memberId ? { ...n, position: { x, y } } : n));
      }
      const existingEdgeId = rfEdges.find((e) => e.source === existing.id || e.target === existing.id)?.id ?? selectedEdgeId;
      if (existingEdgeId) focusEdge(existingEdgeId);
      addToast({ title: t('workflowNodeAlreadyPlacedTitle'), body: t('workflowNodeAlreadyPlacedBody', { name: getMemberLabel(member) }), type: 'info' });
      return;
    }

    const position = typeof x === 'number' && typeof y === 'number'
      ? { x, y }
      : { x: 24 + (rfNodes.length % 3) * 220, y: 24 + Math.floor(rfNodes.length / 3) * 148 };

    setRfNodes((prev) => [...prev, {
      id: member.id,
      type: 'workflow-node',
      position,
      draggable: !member.isSynthetic,
      data: { member, locked: !!member.isSynthetic, onRemove: removeNode },
    }]);
    addToast({ title: t('workflowNodeAddedTitle'), body: t('workflowNodeAddedBody', { name: getMemberLabel(member) }), type: 'success' });
  }, [addToast, focusEdge, getMemberLabel, memberMap, rfEdges, rfNodes, removeNode, selectedEdgeId, setRfNodes, t]);

  const onConnect = useCallback((connection: Connection) => {
    const { source, target } = connection;
    if (!source || !target) return;

    if (source === target) {
      addToast({ title: t('workflowSelfLoopTitle'), body: t('workflowSelfLoopBody'), type: 'warning' });
      return;
    }

    const existing = rfEdges.find((e) => e.source === source && e.target === target);
    if (existing) {
      focusEdge(existing.id);
      return;
    }

    const targetNode = rfNodes.find((n) => n.id === target);
    const targetMember = targetNode?.data.member;
    const action = targetMember?.type === 'agent' ? 'process_and_forward' : 'process_and_report';

    const wfEdge: WorkflowEdge = {
      id: createLocalEdgeId(),
      ruleId: null,
      sourceNodeId: source,
      targetNodeId: target,
      memoTypes: [],
      action,
    };

    setRfEdges((prev) => [...prev, {
      id: wfEdge.id,
      source,
      target,
      type: 'workflow-edge',
      selected: true,
      data: wfEdge as WFEdgeData,
    }]);
    setSelectedEdgeId(wfEdge.id);
    addToast({ title: t('workflowEdgeCreatedTitle'), body: t('workflowEdgeCreatedBody'), type: 'success' });
  }, [addToast, focusEdge, rfEdges, rfNodes, setRfEdges, t]);

  const handleEdgeClick = useCallback((_: unknown, edge: WFRFEdge) => {
    focusEdge(edge.id);
  }, [focusEdge]);

  const updateSelectedEdge = useCallback((patch: Partial<WorkflowEdge>) => {
    if (!selectedEdge) return;
    setRfEdges((prev) => prev.map((e) =>
      e.id === selectedEdge.id ? { ...e, data: { ...e.data!, ...patch } } : e,
    ));
  }, [selectedEdge, setRfEdges]);

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdge) return;
    setRfEdges((prev) => prev.filter((e) => e.id !== selectedEdge.id));
    setSelectedEdgeId(null);
    addToast({ title: t('workflowEdgeDeletedTitle'), body: t('workflowEdgeDeletedBody'), type: 'info' });
  }, [addToast, selectedEdge, setRfEdges, t]);

  const updateSelectedEdgeTarget = useCallback((targetNodeId: string) => {
    if (!selectedEdge) return;
    setRfEdges((prev) => prev.map((e) =>
      e.id === selectedEdge.id
        ? { ...e, target: targetNodeId, data: { ...e.data!, targetNodeId } }
        : e,
    ));
  }, [selectedEdge, setRfEdges]);

  const moveEdge = useCallback((edgeId: string, direction: -1 | 1) => {
    setRfEdges((prev) => {
      const index = prev.findIndex((e) => e.id === edgeId);
      if (index === -1) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [edge] = next.splice(index, 1);
      next.splice(nextIndex, 0, edge);
      return next;
    });
  }, [setRfEdges]);

  const applyTemplate = useCallback((templateId: WorkflowTemplateId) => {
    const template = buildWorkflowTemplate(templateId, members);
    setRfNodes(wfNodesToRF(template.nodes, memberMap, fallbackMember, removeNode));
    setRfEdges(wfEdgesToRF(template.edges, template.edges[0]?.id ?? null));
    setSelectedEdgeId(template.edges[0]?.id ?? null);
    addToast({ title: t('workflowTemplateAppliedTitle'), body: t(`workflowTemplateAppliedBody_${templateId}`), type: 'success' });
  }, [addToast, fallbackMember, memberMap, members, removeNode, setRfEdges, setRfNodes, t]);

  const syncCanvasFromRules = useCallback((rules: RoutingRuleSummary[]) => {
    const nextGraph = buildWorkflowGraphFromRules(rules, members);
    setRfNodes(wfNodesToRF(nextGraph.nodes, memberMap, fallbackMember, removeNode));
    setRfEdges(wfEdgesToRF(nextGraph.edges, nextGraph.edges[0]?.id ?? null));
    setSelectedEdgeId(nextGraph.edges[0]?.id ?? null);
  }, [fallbackMember, memberMap, members, removeNode, setRfEdges, setRfNodes]);

  // ─── API actions ───────────────────────────────────────────────────────────

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const db = createBrowserClient();
    const { data: { session } } = await db.auth.getSession();
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  };

  const saveWorkflow = useCallback(async () => {
    setSaving(true);
    try {
      if (!draftWorkflow.rules) throw new Error(draftWorkflow.error ?? t('workflowSaveErrorBody'));

      const desired = draftWorkflow.rules;
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/v2/agent-routing-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          items: desired.map((rule) => ({
            id: rule.id,
            agent_id: rule.agent_id,
            persona_id: rule.persona_id,
            deployment_id: rule.deployment_id,
            name: rule.name,
            priority: rule.priority,
            match_type: rule.match_type,
            conditions: rule.conditions,
            action: rule.action,
            target_runtime: rule.target_runtime,
            target_model: rule.target_model,
            is_enabled: rule.is_enabled,
          })),
        }),
      });
      const json = await response.json().catch(() => null) as ApiResponse<RoutingRuleSummary[]> | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) throw new Error(parseApiError(json));

      const finalRules = json.data;
      const edgeRuleIdMap = new Map(desired.map((rule, index) => [rule.edgeId, finalRules[index]?.id ?? rule.id ?? null]));

      setSavedRules(finalRules);
      setRfEdges((prev) => prev.map((e) => {
        const ruleId = edgeRuleIdMap.get(e.id) ?? (e.data as WorkflowEdge | undefined)?.ruleId ?? null;
        return { ...e, data: { ...(e.data as WorkflowEdge), ruleId } };
      }));
      setRolloutChecklist({ dryRun: false, expectedPaths: false, recoveryPlan: false });
      addToast({ title: t('workflowSaveSuccessTitle'), body: t('workflowSaveSuccessBody'), type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflowSaveErrorBody');
      addToast({ title: t('workflowSaveErrorTitle'), body: message, type: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [addToast, draftWorkflow.error, draftWorkflow.rules, setRfEdges, t]);

  const rollbackWorkflow = useCallback(async () => {
    if (!rollbackSnapshot?.items.length) return;
    setSaving(true);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/v2/agent-routing-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ items: rollbackSnapshot.items }),
      });
      const json = await response.json().catch(() => null) as ApiResponse<RoutingRuleSummary[]> | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) throw new Error(parseApiError(json));
      setSavedRules(json.data);
      syncCanvasFromRules(json.data);
      addToast({ title: t('workflowRollbackSuccessTitle'), body: t('workflowRollbackSuccessBody'), type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflowRollbackErrorBody');
      addToast({ title: t('workflowRollbackErrorTitle'), body: message, type: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [addToast, rollbackSnapshot, syncCanvasFromRules, t]);

  useEffect(() => {
    void (async () => {
      try {
        const authHeaders = await getAuthHeaders();
        const r = await fetch('/api/v2/workflow-versions', { headers: authHeaders });
        const json = await r.json() as { data?: WorkflowVersionSummary[] };
        if (Array.isArray(json.data)) setVersions(json.data);
      } catch {
        // ignore
      }
    })();
  }, [savedRules]);

  const rollbackToVersion = useCallback(async (versionId: string) => {
    setSaving(true);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch(`/api/v2/workflow-versions/${versionId}/rollback`, { method: 'POST', headers: authHeaders });
      const json = await response.json().catch(() => null) as { data?: RoutingRuleSummary[] } | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) throw new Error(t('workflowRollbackErrorBody'));
      setSavedRules(json.data);
      syncCanvasFromRules(json.data);
      setRollbackConfirmId(null);
      addToast({ title: t('workflowRollbackSuccessTitle'), body: t('workflowRollbackSuccessBody'), type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflowRollbackErrorBody');
      addToast({ title: t('workflowRollbackErrorTitle'), body: message, type: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [addToast, syncCanvasFromRules, t]);

  const disableWorkflow = useCallback(async () => {
    if (savedRules.length === 0) return;
    setSaving(true);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/v2/agent-routing-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ disable_all: true }),
      });
      const json = await response.json().catch(() => null) as ApiResponse<RoutingRuleSummary[]> | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) throw new Error(parseApiError(json));
      setSavedRules(json.data);
      syncCanvasFromRules(json.data);
      addToast({ title: t('workflowDisableSuccessTitle'), body: t('workflowDisableSuccessBody'), type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflowDisableErrorBody');
      addToast({ title: t('workflowDisableErrorTitle'), body: message, type: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [addToast, savedRules.length, syncCanvasFromRules, t]);

  const handleSave = useCallback(async () => {
    if (!canRollout) return;
    await saveWorkflow();
  }, [canRollout, saveWorkflow]);

  const onCanvasDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const memberId = event.dataTransfer.getData(EDGE_DATA_MIME);
    if (!memberId) return;
    const rect = (event.target as HTMLElement).closest('.react-flow')?.getBoundingClientRect();
    if (!rect) {
      addMemberNode(memberId);
      return;
    }
    addMemberNode(memberId, event.clientX - rect.left - NODE_WIDTH / 2, event.clientY - rect.top - 46);
  }, [addMemberNode]);

  // ─── No agents guard ────────────────────────────────────────────────────────

  if (agentMembers.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow={t('statusEyebrow')} title={t('workflowEditorTitle')} description={t('workflowEditorDescription', { project: projectName })} />
        <SectionCard>
          <SectionCardBody className="py-12 text-center">
            <Bot className="mx-auto size-10 text-primary" />
            <h2 className="mt-4 text-lg font-semibold text-foreground">{t('workflowNoAgentsTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('workflowNoAgentsBody')}</p>
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-4">
        <PageHeader
          eyebrow={t('statusEyebrow')}
          title={t('workflowEditorTitle')}
          description={t('workflowEditorDescription', { project: projectName })}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="chip">{t('workflowRuleCount', { count: rfEdges.length })}</Badge>
              <Button variant="hero" size="lg" disabled={!canRollout} onClick={handleSave}>
                <Save className="mr-2 size-4" />
                {saving ? t('workflowSaving') : tc('save')}
              </Button>
            </div>
          )}
        />

        {cycleWarnings.length > 0 ? (
          <SectionCard>
            <SectionCardBody className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 text-amber-300" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('workflowCycleWarningTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('workflowCycleWarningBody', { cycles: cycleWarnings.join(' · ') })}</p>
                </div>
              </div>
              <Badge variant="outline">{t('workflowCycleWarningAllowsSave')}</Badge>
            </SectionCardBody>
          </SectionCard>
        ) : null}

        {/* ── Dry run / Expected paths / Rollout checklist ── */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <Route className="size-4 text-primary" />
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('workflowDryRunTitle')}</h2>
                  <p className="text-sm text-muted-foreground">{t('workflowDryRunBody')}</p>
                </div>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button variant={dryRunSurface === 'draft' ? 'hero' : 'glass'} size="sm" disabled={!draftWorkflow.rules} onClick={() => setDryRunSurface('draft')}>
                  {t('workflowDryRunDraft')}
                </Button>
                <Button variant={dryRunSurface === 'live' ? 'hero' : 'glass'} size="sm" onClick={() => setDryRunSurface('live')}>
                  {t('workflowDryRunLive')}
                </Button>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowDryRunMemoTypeLabel')}</label>
                <select
                  value={dryRunMemoType}
                  onChange={(event) => setDryRunMemoType(event.target.value as (typeof WORKFLOW_MEMO_TYPE_OPTIONS)[number])}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                >
                  {WORKFLOW_MEMO_TYPE_OPTIONS.map((mt) => (
                    <option key={mt} value={mt}>{memoTypeLabels[mt]}</option>
                  ))}
                </select>
              </div>
              {dryRunSurface === 'draft' && draftWorkflow.error ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
                  {t('workflowDraftInvalidBody', { error: draftWorkflow.error })}
                </div>
              ) : (
                <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant={activeDryRunPreview.result === 'forward' ? 'info' : activeDryRunPreview.result === 'report' ? 'chip' : 'outline'}>
                      {getPreviewOutcomeLabel(activeDryRunPreview.result)}
                    </Badge>
                    <Badge variant="outline">{memoTypeLabels[dryRunMemoType]}</Badge>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowDryRunPathLabel')}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatPreviewPath(activeDryRunPreview.steps)}</p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                    {activeDryRunPreview.matchedRuleName
                      ? t('workflowDryRunMatchedRule', { name: activeDryRunPreview.matchedRuleName })
                      : t('workflowDryRunNoRule')}
                  </div>
                </div>
              )}
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <ClipboardCheck className="size-4 text-primary" />
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('workflowExpectedPathsTitle')}</h2>
                  <p className="text-sm text-muted-foreground">{t('workflowExpectedPathsBody')}</p>
                </div>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {visiblePreviewMemoTypes.map((memoType) => {
                const livePreview = livePreviewMap.get(memoType) ?? simulateWorkflowRoute(savedRules, members, memoType);
                const draftPreview = draftPreviewMap.get(memoType) ?? livePreview;
                const changed = draftWorkflow.rules ? JSON.stringify(livePreview) !== JSON.stringify(draftPreview) : hasDraftChanges;
                return (
                  <button
                    key={memoType}
                    type="button"
                    onClick={() => { setDryRunMemoType(memoType); setDryRunSurface('draft'); }}
                    className={`w-full rounded-md border px-4 py-3 text-left transition ${changed ? 'border-primary/30 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-foreground">{memoTypeLabels[memoType]}</p>
                      {changed ? <Badge variant="info">{t('workflowExpectedPathsChanged')}</Badge> : <Badge variant="outline">{t('workflowExpectedPathsUnchanged')}</Badge>}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowDryRunLive')}</p>
                        <p className="mt-2 text-sm text-foreground">{formatPreviewPath(livePreview.steps)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowDryRunDraft')}</p>
                        <p className="mt-2 text-sm text-foreground">{draftWorkflow.rules ? formatPreviewPath(draftPreview.steps) : t('workflowDraftInvalidShort')}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" />
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('workflowRolloutChecklistTitle')}</h2>
                  <p className="text-sm text-muted-foreground">{t('workflowRolloutChecklistBody')}</p>
                </div>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="chip">{t('workflowRolloutChangedRules', { count: workflowDiff.changedRules })}</Badge>
                <Badge variant="outline">{t('workflowRolloutAddedRules', { count: workflowDiff.addedRules })}</Badge>
                <Badge variant="outline">{t('workflowRolloutRemovedRules', { count: workflowDiff.removedRules })}</Badge>
              </div>
              {draftWorkflow.error ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
                  {t('workflowDraftInvalidBody', { error: draftWorkflow.error })}
                </div>
              ) : !hasDraftChanges ? (
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  {t('workflowRolloutNoChanges')}
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.dryRun} onChange={(e) => setRolloutChecklist((prev) => ({ ...prev, dryRun: e.target.checked }))} />
                    <span>{t('workflowRolloutChecklistDryRun')}</span>
                  </label>
                  <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.expectedPaths} onChange={(e) => setRolloutChecklist((prev) => ({ ...prev, expectedPaths: e.target.checked }))} />
                    <span>{t('workflowRolloutChecklistExpectedPaths')}</span>
                  </label>
                  <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-foreground">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.recoveryPlan} onChange={(e) => setRolloutChecklist((prev) => ({ ...prev, recoveryPlan: e.target.checked }))} />
                    <span>{t('workflowRolloutChecklistRecovery')}</span>
                  </label>
                </>
              )}
              <div className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                {rollbackSnapshot?.items.length ? t('workflowRolloutRollbackReady') : t('workflowRolloutRollbackMissing')}
              </div>
              <div className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                {savedRules.length > 0 ? t('workflowRolloutDisableReady') : t('workflowRolloutDisableEmpty')}
              </div>
              <Badge variant={canRollout ? 'info' : 'outline'}>{canRollout ? t('workflowRolloutReady') : t('workflowRolloutBlocked')}</Badge>
            </SectionCardBody>
          </SectionCard>
        </div>

        {/* ── Emergency controls ── */}
        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <Ban className="size-4 text-amber-300" />
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('workflowEmergencyTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('workflowEmergencyBody')}</p>
              </div>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button variant="glass" size="lg" disabled={saving || !rollbackSnapshot?.items.length} onClick={rollbackWorkflow}>
              <RotateCcw className="mr-2 size-4" />
              {t('workflowEmergencyRollback')}
            </Button>
            <Button variant="destructive" size="lg" disabled={saving || savedRules.length === 0 || savedRules.every((rule) => rule.is_enabled === false)} onClick={disableWorkflow}>
              <Ban className="mr-2 size-4" />
              {t('workflowEmergencyDisable')}
            </Button>
          </SectionCardBody>
        </SectionCard>

        {/* ── Mobile fallback ── */}
        <div className="space-y-4 lg:hidden">
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <Smartphone className="size-4 text-primary" />
                <h2 className="text-base font-semibold text-foreground">{t('workflowMobileTitle')}</h2>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('workflowMobileBody')}</p>
              <p className="text-sm text-muted-foreground">{t('workflowDesktopHint')}</p>
            </SectionCardBody>
          </SectionCard>
          <SectionCard>
            <SectionCardHeader>
              <h2 className="text-base font-semibold text-foreground">{t('workflowPriorityTitle')}</h2>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {rfEdges.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('workflowPriorityEmpty')}</p>
              ) : rfEdges.map((rfEdge, index) => {
                const wfEdge = rfEdge.data as WorkflowEdge;
                const summary = getEdgeSummary(wfEdge, graph, members);
                return (
                  <div key={rfEdge.id} className="rounded-md border border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">#{index + 1} {getMemberLabel(summary.source)} → {getMemberLabel(summary.target)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatMemoTypes(summary.memoTypes)} · {getActionLabel(wfEdge.action)}</p>
                      </div>
                      <Badge variant="chip">{summary.target?.type === 'agent' ? t('workflowMembersAgents') : t('workflowHumanBadge')}</Badge>
                    </div>
                  </div>
                );
              })}
            </SectionCardBody>
          </SectionCard>
        </div>

        {/* ── Desktop: Templates + Canvas + Edge config ── */}
        <div className="hidden gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_320px]">
          {/* Templates + Members */}
          <div className="space-y-4">
            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">{t('workflowTemplatesTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('workflowTemplatesBody')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-2">
                <button className={buttonVariants({ variant: 'glass', size: 'lg', className: 'w-full justify-start' })} onClick={() => applyTemplate('standard-dev')}>
                  {t('workflowTemplateStandard')}
                </button>
                <button className={buttonVariants({ variant: 'glass', size: 'lg', className: 'w-full justify-start' })} onClick={() => applyTemplate('review-heavy')}>
                  {t('workflowTemplateReview')}
                </button>
                <button className={buttonVariants({ variant: 'glass', size: 'lg', className: 'w-full justify-start' })} onClick={() => applyTemplate('solo-dev')}>
                  {t('workflowTemplateSolo')}
                </button>
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">{t('workflowMembersTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('workflowMembersBody')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    <Bot className="size-3.5" /> {t('workflowMembersAgents')}
                  </div>
                  <div className="space-y-2">
                    {agentMembers.map((member) => (
                      <button
                        key={member.id}
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData(EDGE_DATA_MIME, member.id)}
                        onClick={() => addMemberNode(member.id)}
                        className="w-full rounded-md border border-border bg-muted/30 px-3 py-3 text-left transition hover:bg-muted"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{member.name}</p>
                            <p className="text-xs text-muted-foreground">{member.role ?? t('workflowMembersAgents')}</p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    <User className="size-3.5" /> {t('workflowMembersHumans')}
                  </div>
                  <div className="space-y-2">
                    {humanMembers.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">{t('workflowNoHumans')}</p>
                    ) : humanMembers.map((member) => (
                      <button
                        key={member.id}
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData(EDGE_DATA_MIME, member.id)}
                        onClick={() => addMemberNode(member.id)}
                        className="w-full rounded-md border border-border bg-muted/30 px-3 py-3 text-left transition hover:bg-muted"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-foreground">{member.name}</p>
                            <p className="text-xs text-muted-foreground">{member.role ?? t('workflowHumanBadge')}</p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                  {t('workflowDragHint')}
                </div>
              </SectionCardBody>
            </SectionCard>
          </div>

          {/* ReactFlow Canvas */}
          <SectionCard>
            <SectionCardHeader>
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('workflowCanvasTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('workflowCanvasBody')}</p>
              </div>
            </SectionCardHeader>
            <SectionCardBody>
              <div
                className="h-[620px] overflow-hidden rounded-xl border border-dashed border-border bg-muted/10"
                onDragOver={(event) => event.preventDefault()}
                onDrop={onCanvasDrop}
              >
                <ReactFlow
                  nodes={rfNodes}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onEdgeClick={handleEdgeClick}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  deleteKeyCode={null}
                  className="bg-transparent"
                >
                  <Background color="#94a3b820" gap={24} />
                  <Controls className="!border-border !bg-card !shadow-sm" />
                  <svg style={{ position: 'absolute', width: 0, height: 0 }}>
                    <defs>
                      <marker id="workflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                      </marker>
                      <marker id="workflow-arrow-selected" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c3aed" />
                      </marker>
                    </defs>
                  </svg>
                </ReactFlow>
              </div>
            </SectionCardBody>
          </SectionCard>

          {/* Edge config */}
          <div className="space-y-4">
            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">{t('workflowPriorityTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('workflowPriorityBody')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-2">
                {rfEdges.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">{t('workflowPriorityEmpty')}</p>
                ) : rfEdges.map((rfEdge, index) => {
                  const wfEdge = rfEdge.data as WorkflowEdge;
                  const summary = getEdgeSummary(wfEdge, graph, members);
                  const isSelected = rfEdge.id === selectedEdgeId;
                  return (
                    <div
                      key={rfEdge.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => focusEdge(rfEdge.id)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusEdge(rfEdge.id); } }}
                      className={`w-full rounded-md border px-3 py-3 text-left transition ${isSelected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-foreground">#{index + 1} {getMemberLabel(summary.source)} → {getMemberLabel(summary.target)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatMemoTypes(summary.memoTypes)} · {getActionLabel(wfEdge.action)}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={(e) => { e.stopPropagation(); moveEdge(rfEdge.id, -1); }}>
                            <ArrowUp className="size-4" />
                          </button>
                          <button type="button" className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={(e) => { e.stopPropagation(); moveEdge(rfEdge.id, 1); }}>
                            <ArrowDown className="size-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">{t('workflowEdgeConfigTitle')}</h2>
                <p className="text-sm text-muted-foreground">{selectedEdge ? t('workflowEdgeConfigBody') : t('workflowNoEdgeSelected')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-4">
                {selectedEdge && selectedEdgeSummary ? (
                  <>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
                      <p className="text-sm font-semibold text-foreground">{getMemberLabel(selectedEdgeSummary.source)} → {getMemberLabel(selectedEdgeSummary.target)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{selectedEdgeSummary.target?.type === 'agent' ? t('workflowForwardAgentHint') : t('workflowHumanTargetHint')}</p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowMatchTypeLabel')}</label>
                      <select
                        value={selectedEdge.matchType ?? 'event'}
                        onChange={(event) => updateSelectedEdge({ matchType: event.target.value })}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                      >
                        <option value="event">{t('workflowMatchTypeEvent')}</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowActionLabel')}</label>
                      <div className="flex flex-col gap-2">
                        {(['process_and_report', 'process_and_forward'] as const).map((mode) => (
                          <label key={mode} className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition ${selectedEdge.action === mode ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                            <input
                              type="radio"
                              name={`action-${selectedEdge.id}`}
                              value={mode}
                              checked={selectedEdge.action === mode}
                              onChange={() => updateSelectedEdge({ action: mode })}
                              className="size-4"
                            />
                            <span>{mode === 'process_and_report' ? t('workflowActionReport') : t('workflowActionForward')}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {selectedEdge.action === 'process_and_forward' && (
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowForwardTargetLabel')}</label>
                        <select
                          value={selectedEdge.targetNodeId}
                          onChange={(event) => updateSelectedEdgeTarget(event.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        >
                          {agentMembers.filter((m) => m.id !== selectedEdge.sourceNodeId).map((m) => (
                            <option key={m.id} value={m.id}>{getMemberLabel(m)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t('workflowMemoTypesLabel')}</label>
                        <button type="button" className="text-xs text-primary hover:underline" onClick={() => updateSelectedEdge({ memoTypes: [] })}>{t('workflowAllMemoTypes')}</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {WORKFLOW_MEMO_TYPE_OPTIONS.map((memoType) => {
                          const checked = selectedEdge.memoTypes.includes(memoType);
                          return (
                            <label key={memoType} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition ${checked ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                              <input
                                type="checkbox"
                                className="size-4 rounded border-input"
                                checked={checked}
                                onChange={() => updateSelectedEdge({
                                  memoTypes: checked
                                    ? selectedEdge.memoTypes.filter((v) => v !== memoType)
                                    : [...selectedEdge.memoTypes, memoType],
                                })}
                              />
                              <span>{memoTypeLabels[memoType]}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <Button variant="destructive" size="lg" className="w-full" onClick={removeSelectedEdge}>
                      <Trash2 className="mr-2 size-4" />
                      {t('workflowDeleteEdge')}
                    </Button>
                  </>
                ) : null}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">{t('workflowVersionHistoryTitle')}</h2>
              </SectionCardHeader>
              <SectionCardBody className="space-y-3">
                {versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('workflowVersionHistoryEmpty')}</p>
                ) : versions.map((ver) => {
                  const isSelected = ver.id === selectedVersionId;
                  const isConfirming = ver.id === rollbackConfirmId;
                  const cs = ver.change_summary;
                  return (
                    <div
                      key={ver.id}
                      className={`cursor-pointer rounded-md border px-3 py-3 transition ${isSelected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:border-primary/20 hover:bg-muted/50'}`}
                      onClick={() => setSelectedVersionId(isSelected ? null : ver.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">v{ver.version}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {new Date(ver.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {cs && (
                              <span className="ml-2 gap-1 inline-flex">
                                {cs.added_rules > 0 && <span className="text-emerald-500">+{cs.added_rules}</span>}
                                {cs.removed_rules > 0 && <span className="text-destructive">-{cs.removed_rules}</span>}
                                {cs.changed_rules > 0 && <span className="text-amber-500">~{cs.changed_rules}</span>}
                              </span>
                            )}
                          </p>
                        </div>
                        <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
                      </div>
                      {isSelected && (
                        <div className="mt-3 space-y-2 border-t border-border pt-3">
                          {ver.snapshot.length > 0 ? (
                            <ul className="space-y-1">
                              {ver.snapshot.map((rule, i) => (
                                <li key={`${rule.name}-${i}`} className="text-xs text-muted-foreground">
                                  {rule.name}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted-foreground">{t('workflowVersionHistoryEmpty')}</p>
                          )}
                          {isConfirming ? (
                            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                              <p className="text-xs text-foreground">{t('workflowVersionRollbackConfirmBody')}</p>
                              <div className="flex gap-2">
                                <Button variant="destructive" size="sm" className="flex-1" disabled={saving} onClick={() => rollbackToVersion(ver.id)}>
                                  {t('workflowVersionRollbackConfirm')}
                                </Button>
                                <Button variant="ghost" size="sm" className="flex-1" onClick={() => setRollbackConfirmId(null)}>
                                  {t('workflowVersionRollbackCancel')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button variant="glass" size="sm" className="w-full" onClick={(e) => { e.stopPropagation(); setRollbackConfirmId(ver.id); }}>
                              <RotateCcw className="mr-2 size-3" />
                              {t('workflowVersionRollbackButton')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </SectionCardBody>
            </SectionCard>
          </div>
        </div>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

// ─── Export (wrapped with ReactFlowProvider) ──────────────────────────────────

export function AgentWorkflowEditor(props: AgentWorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <AgentWorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
