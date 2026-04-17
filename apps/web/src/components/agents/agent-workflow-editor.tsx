'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Ban, Bot, ClipboardCheck, Link2, Plus, RotateCcw, Route, Save, ShieldCheck, Smartphone, Trash2, TriangleAlert, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { getRollbackSnapshotFromRules, type RoutingRuleSummary } from '@/services/agent-routing-rule';
import {
  WORKFLOW_MEMO_TYPE_OPTIONS,
  WORKFLOW_ORIGINAL_ASSIGNEE_ID,
  buildWorkflowGraphFromRules,
  buildWorkflowPreviewCatalog,
  buildWorkflowTemplate,
  detectWorkflowCycles,
  getEdgeSummary,
  getNodeCenter,
  getNodeSize,
  getWorkflowMembers,
  serializeWorkflowGraph,
  simulateWorkflowRoute,
  summarizeWorkflowDiff,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowMember,
  type WorkflowTemplateId,
} from '@/services/agent-workflow-editor';

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

export function AgentWorkflowEditor({ initialMembers, initialRules, projectName }: AgentWorkflowEditorProps) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const { toasts, addToast, dismissToast } = useToast();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const nodeSize = getNodeSize();

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

  const initialGraph = useMemo(
    () => buildWorkflowGraphFromRules(initialRules, members),
    [initialRules, members],
  );

  const [nodes, setNodes] = useState(initialGraph.nodes);
  const [edges, setEdges] = useState(initialGraph.edges);
  const [savedRules, setSavedRules] = useState(initialRules);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(initialGraph.edges[0]?.id ?? null);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dryRunMemoType, setDryRunMemoType] = useState<(typeof WORKFLOW_MEMO_TYPE_OPTIONS)[number]>('task');
  const [dryRunSurface, setDryRunSurface] = useState<'draft' | 'live'>('draft');
  const [rolloutChecklist, setRolloutChecklist] = useState({
    dryRun: false,
    expectedPaths: false,
    recoveryPlan: false,
  });

  const graph = useMemo<WorkflowGraph>(() => ({ nodes, edges }), [nodes, edges]);
  const memberMap = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);
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
      return {
        rules: serializeWorkflowGraph(graph, members, savedRules),
        error: null,
      };
    } catch (error) {
      return {
        rules: null,
        error: error instanceof Error ? error.message : 'workflow_invalid',
      };
    }
  }, [graph, members, savedRules]);
  const workflowDiff = useMemo(
    () => (draftWorkflow.rules ? summarizeWorkflowDiff(savedRules, draftWorkflow.rules) : {
      hasChanges: hasDraftChanges,
      addedRules: 0,
      removedRules: 0,
      changedRules: 0,
      impactedMemoTypes: [],
    }),
    [draftWorkflow.rules, hasDraftChanges, savedRules],
  );
  const livePreviewCatalog = useMemo(() => buildWorkflowPreviewCatalog(savedRules, members), [savedRules, members]);
  const draftPreviewCatalog = useMemo(
    () => (draftWorkflow.rules ? buildWorkflowPreviewCatalog(draftWorkflow.rules, members) : []),
    [draftWorkflow.rules, members],
  );
  const livePreviewMap = useMemo(() => new Map(livePreviewCatalog.map((preview) => [preview.memoType, preview])), [livePreviewCatalog]);
  const draftPreviewMap = useMemo(() => new Map(draftPreviewCatalog.map((preview) => [preview.memoType, preview])), [draftPreviewCatalog]);
  const visiblePreviewMemoTypes = useMemo(() => {
    if (workflowDiff.impactedMemoTypes.length === 0) return [...WORKFLOW_MEMO_TYPE_OPTIONS];
    return WORKFLOW_MEMO_TYPE_OPTIONS.filter((memoType) => workflowDiff.impactedMemoTypes.includes(memoType));
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

  const getMemberLabel = useCallback((member: WorkflowMember | null | undefined) => {
    if (!member) return '';
    return member.isSynthetic ? t('workflowOriginalAssignee') : member.name;
  }, [t]);

  const formatMemoTypes = useCallback((memoTypes: string[]) => {
    if (memoTypes.length === 0) return t('workflowAllMemoTypes');
    return memoTypes.map((memoType) => memoTypeLabels[memoType as keyof typeof memoTypeLabels] ?? memoType).join(', ');
  }, [memoTypeLabels, t]);

  const getActionLabel = useCallback((action: WorkflowEdge['action']) => {
    return action === 'process_and_forward' ? t('workflowActionForward') : t('workflowActionReport');
  }, [t]);

  const formatPreviewPath = useCallback((steps: WorkflowMember[]) => steps.map((step) => getMemberLabel(step)).join(' → '), [getMemberLabel]);
  const getPreviewOutcomeLabel = useCallback((result: 'fallback' | 'report' | 'forward') => {
    if (result === 'forward') return t('workflowDryRunOutcomeForward');
    if (result === 'report') return t('workflowDryRunOutcomeReport');
    return t('workflowDryRunOutcomeFallback');
  }, [t]);

  useEffect(() => {
    if (!visiblePreviewMemoTypes.includes(dryRunMemoType)) {
      setDryRunMemoType(visiblePreviewMemoTypes[0] ?? 'task');
    }
  }, [dryRunMemoType, visiblePreviewMemoTypes]);

  useEffect(() => {
    if (!hasDraftChanges) {
      setDryRunSurface('live');
    }
  }, [hasDraftChanges]);

  useEffect(() => {
    setRolloutChecklist({
      dryRun: false,
      expectedPaths: false,
      recoveryPlan: false,
    });
  }, [hasDraftChanges, draftWorkflow.error, workflowDiff.changedRules]);

  const clampPosition = useCallback((x: number, y: number) => {
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!canvasRect) return { x, y };
    return {
      x: Math.max(12, Math.min(x, canvasRect.width - nodeSize.width - 12)),
      y: Math.max(12, Math.min(y, canvasRect.height - nodeSize.height - 12)),
    };
  }, [nodeSize.height, nodeSize.width]);

  const moveNode = useCallback((nodeId: string, x: number, y: number) => {
    const next = clampPosition(x, y);
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, ...next } : node)));
  }, [clampPosition]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const current = dragRef.current;
    if (!current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    moveNode(current.nodeId, event.clientX - rect.left - current.offsetX, event.clientY - rect.top - current.offsetY);
  }, [moveNode]);

  const stopDragging = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopDragging);
  }, [handlePointerMove]);

  const startDragging = useCallback((event: ReactPointerEvent, nodeId: string) => {
    if ((event.target as HTMLElement).closest('[data-node-action="true"]')) return;
    const node = nodeMap.get(nodeId);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!node || !rect) return;

    dragRef.current = {
      nodeId,
      offsetX: event.clientX - rect.left - node.x,
      offsetY: event.clientY - rect.top - node.y,
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
  }, [handlePointerMove, nodeMap, stopDragging]);

  const focusEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setConnectionSourceId(null);
  }, []);

  const addMemberNode = useCallback((memberId: string, x?: number, y?: number) => {
    const member = memberMap.get(memberId);
    if (!member) return;

    const existing = nodeMap.get(memberId);
    if (existing) {
      if (typeof x === 'number' && typeof y === 'number') moveNode(existing.id, x, y);
      const existingEdgeId = edges.find((edge) => edge.sourceNodeId === existing.id || edge.targetNodeId === existing.id)?.id ?? selectedEdgeId;
      if (existingEdgeId) focusEdge(existingEdgeId);
      addToast({ title: t('workflowNodeAlreadyPlacedTitle'), body: t('workflowNodeAlreadyPlacedBody', { name: getMemberLabel(member) }), type: 'info' });
      return;
    }

    const nextPosition = typeof x === 'number' && typeof y === 'number'
      ? clampPosition(x, y)
      : clampPosition(24 + (nodes.length % 3) * 220, 24 + Math.floor(nodes.length / 3) * 148);

    setNodes((prev) => [...prev, {
      id: member.id,
      memberId: member.id,
      x: nextPosition.x,
      y: nextPosition.y,
      locked: member.isSynthetic,
    }]);

    addToast({ title: t('workflowNodeAddedTitle'), body: t('workflowNodeAddedBody', { name: getMemberLabel(member) }), type: 'success' });
  }, [addToast, clampPosition, edges, focusEdge, getMemberLabel, memberMap, moveNode, nodeMap, nodes.length, selectedEdgeId, t]);

  const removeNode = useCallback((nodeId: string) => {
    if (nodeId === WORKFLOW_ORIGINAL_ASSIGNEE_ID) return;
    setNodes((prev) => prev.filter((node) => node.id !== nodeId));
    setEdges((prev) => prev.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId));
    if (selectedEdge && (selectedEdge.sourceNodeId === nodeId || selectedEdge.targetNodeId === nodeId)) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdge]);

  const startConnection = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    const member = node ? memberMap.get(node.memberId) : null;
    if (!node || !member) return;
    if (member.type !== 'agent') {
      addToast({ title: t('workflowHumanSourceTitle'), body: t('workflowHumanSourceBody'), type: 'warning' });
      return;
    }
    setConnectionSourceId(nodeId);
  }, [addToast, memberMap, nodeMap, t]);

  const createEdge = useCallback((sourceNodeId: string, targetNodeId: string) => {
    if (sourceNodeId === targetNodeId) {
      addToast({ title: t('workflowSelfLoopTitle'), body: t('workflowSelfLoopBody'), type: 'warning' });
    }

    const existing = edges.find((edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId);
    if (existing) {
      focusEdge(existing.id);
      return;
    }

    const targetNode = nodeMap.get(targetNodeId);
    const targetMember = targetNode ? memberMap.get(targetNode.memberId) : null;
    const action = targetMember?.type === 'agent' ? 'process_and_forward' : 'process_and_report';
    const edge: WorkflowEdge = {
      id: createLocalEdgeId(),
      ruleId: null,
      sourceNodeId,
      targetNodeId,
      memoTypes: [],
      action,
    };
    setEdges((prev) => [...prev, edge]);
    focusEdge(edge.id);
    addToast({ title: t('workflowEdgeCreatedTitle'), body: t('workflowEdgeCreatedBody'), type: 'success' });
  }, [addToast, edges, focusEdge, memberMap, nodeMap, t]);

  const handleNodeSelect = useCallback((nodeId: string) => {
    if (!connectionSourceId) return;
    createEdge(connectionSourceId, nodeId);
    setConnectionSourceId(null);
  }, [connectionSourceId, createEdge]);

  const updateSelectedEdge = useCallback((patch: Partial<WorkflowEdge>) => {
    if (!selectedEdge) return;
    setEdges((prev) => prev.map((edge) => edge.id === selectedEdge.id ? { ...edge, ...patch } : edge));
  }, [selectedEdge]);

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdge) return;
    setEdges((prev) => prev.filter((edge) => edge.id !== selectedEdge.id));
    setSelectedEdgeId(null);
    addToast({ title: t('workflowEdgeDeletedTitle'), body: t('workflowEdgeDeletedBody'), type: 'info' });
  }, [addToast, selectedEdge, t]);

  const moveEdge = useCallback((edgeId: string, direction: -1 | 1) => {
    setEdges((prev) => {
      const index = prev.findIndex((edge) => edge.id === edgeId);
      if (index === -1) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [edge] = next.splice(index, 1);
      next.splice(nextIndex, 0, edge);
      return next;
    });
  }, []);

  const applyTemplate = useCallback((templateId: WorkflowTemplateId) => {
    const template = buildWorkflowTemplate(templateId, members);
    setNodes(template.nodes);
    setEdges(template.edges);
    setSelectedEdgeId(template.edges[0]?.id ?? null);
    setConnectionSourceId(null);
    addToast({ title: t('workflowTemplateAppliedTitle'), body: t(`workflowTemplateAppliedBody_${templateId}`), type: 'success' });
  }, [addToast, members, t]);

  const syncCanvasFromRules = useCallback((rules: RoutingRuleSummary[]) => {
    const nextGraph = buildWorkflowGraphFromRules(rules, members);
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
    setSelectedEdgeId(nextGraph.edges[0]?.id ?? null);
    setConnectionSourceId(null);
  }, [members]);

  const saveWorkflow = useCallback(async () => {
    setSaving(true);
    try {
      if (!draftWorkflow.rules) {
        throw new Error(draftWorkflow.error ?? t('workflowSaveErrorBody'));
      }

      const desired = draftWorkflow.rules;
      const response = await fetch('/api/v1/agent-routing-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
      if (!response.ok || !json?.data || !Array.isArray(json.data)) {
        throw new Error(parseApiError(json));
      }

      const finalRules = json.data;
      const edgeRuleIdMap = new Map(desired.map((rule, index) => [rule.edgeId, finalRules[index]?.id ?? rule.id ?? null]));

      setSavedRules(finalRules);
      setEdges((prev) => prev.map((edge) => ({ ...edge, ruleId: edgeRuleIdMap.get(edge.id) ?? null })));
      setRolloutChecklist({ dryRun: false, expectedPaths: false, recoveryPlan: false });
      addToast({ title: t('workflowSaveSuccessTitle'), body: t('workflowSaveSuccessBody'), type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflowSaveErrorBody');
      addToast({ title: t('workflowSaveErrorTitle'), body: message, type: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [addToast, draftWorkflow.error, draftWorkflow.rules, t]);

  const rollbackWorkflow = useCallback(async () => {
    if (!rollbackSnapshot?.items.length) return;

    setSaving(true);
    try {
      const response = await fetch('/api/v1/agent-routing-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: rollbackSnapshot.items }),
      });
      const json = await response.json().catch(() => null) as ApiResponse<RoutingRuleSummary[]> | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) {
        throw new Error(parseApiError(json));
      }

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

  const disableWorkflow = useCallback(async () => {
    if (savedRules.length === 0) return;

    setSaving(true);
    try {
      const response = await fetch('/api/v1/agent-routing-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable_all: true }),
      });
      const json = await response.json().catch(() => null) as ApiResponse<RoutingRuleSummary[]> | null;
      if (!response.ok || !json?.data || !Array.isArray(json.data)) {
        throw new Error(parseApiError(json));
      }

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
    if (!memberId || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    addMemberNode(memberId, event.clientX - rect.left - nodeSize.width / 2, event.clientY - rect.top - nodeSize.height / 2);
  }, [addMemberNode, nodeSize.height, nodeSize.width]);

  const renderEdgeLabel = (edge: WorkflowEdge, index: number) => {
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    const targetNode = nodeMap.get(edge.targetNodeId);
    if (!sourceNode || !targetNode) return null;
    const source = getNodeCenter(sourceNode);
    const target = getNodeCenter(targetNode);
    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2;
    const isSelected = edge.id === selectedEdgeId;

    return (
      <g key={edge.id} className="cursor-pointer" onClick={() => focusEdge(edge.id)}>
        <line
          x1={source.x}
          y1={source.y}
          x2={target.x}
          y2={target.y}
          stroke={isSelected ? '#7c3aed' : '#94a3b8'}
          strokeWidth={isSelected ? 3 : 2}
          markerEnd="url(#workflow-arrow)"
        />
        <line
          x1={source.x}
          y1={source.y}
          x2={target.x}
          y2={target.y}
          stroke="transparent"
          strokeWidth={18}
        />
        <foreignObject x={midX - 62} y={midY - 16} width={124} height={32}>
          <div className={`flex h-8 items-center justify-center rounded-full border px-2 text-[11px] font-medium ${isSelected ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-white/10 bg-slate-900/80 text-slate-100'}`}>
            #{index + 1} · {formatMemoTypes(edge.memoTypes)}
          </div>
        </foreignObject>
      </g>
    );
  };

  if (agentMembers.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow={t('statusEyebrow')} title={t('workflowEditorTitle')} description={t('workflowEditorDescription', { project: projectName })} />
        <SectionCard>
          <SectionCardBody className="py-12 text-center">
            <Bot className="mx-auto size-10 text-[color:var(--operator-primary-soft)]" />
            <h2 className="mt-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('workflowNoAgentsTitle')}</h2>
            <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t('workflowNoAgentsBody')}</p>
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <PageHeader
          eyebrow={t('statusEyebrow')}
          title={t('workflowEditorTitle')}
          description={t('workflowEditorDescription', { project: projectName })}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="chip">{t('workflowRuleCount', { count: edges.length })}</Badge>
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
                  <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('workflowCycleWarningTitle')}</p>
                  <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{t('workflowCycleWarningBody', { cycles: cycleWarnings.join(' · ') })}</p>
                </div>
              </div>
              <Badge variant="outline">{t('workflowCycleWarningAllowsSave')}</Badge>
            </SectionCardBody>
          </SectionCard>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <Route className="size-4 text-[color:var(--operator-primary-soft)]" />
                <div>
                  <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowDryRunTitle')}</h2>
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowDryRunBody')}</p>
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
                <label className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowDryRunMemoTypeLabel')}</label>
                <select
                  value={dryRunMemoType}
                  onChange={(event) => setDryRunMemoType(event.target.value as (typeof WORKFLOW_MEMO_TYPE_OPTIONS)[number])}
                  className="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-[color:var(--operator-foreground)]"
                >
                  {WORKFLOW_MEMO_TYPE_OPTIONS.map((memoType) => (
                    <option key={memoType} value={memoType}>{memoTypeLabels[memoType]}</option>
                  ))}
                </select>
              </div>

              {dryRunSurface === 'draft' && draftWorkflow.error ? (
                <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {t('workflowDraftInvalidBody', { error: draftWorkflow.error })}
                </div>
              ) : (
                <div className="space-y-3 rounded-3xl border border-white/10 bg-white/4 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant={activeDryRunPreview.result === 'forward' ? 'info' : activeDryRunPreview.result === 'report' ? 'chip' : 'outline'}>
                      {getPreviewOutcomeLabel(activeDryRunPreview.result)}
                    </Badge>
                    <Badge variant="outline">{memoTypeLabels[dryRunMemoType]}</Badge>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowDryRunPathLabel')}</p>
                    <p className="mt-2 text-sm font-semibold text-[color:var(--operator-foreground)]">{formatPreviewPath(activeDryRunPreview.steps)}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-3 text-sm text-[color:var(--operator-muted)]">
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
                <ClipboardCheck className="size-4 text-[color:var(--operator-primary-soft)]" />
                <div>
                  <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowExpectedPathsTitle')}</h2>
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowExpectedPathsBody')}</p>
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
                    onClick={() => {
                      setDryRunMemoType(memoType);
                      setDryRunSurface('draft');
                    }}
                    className={`w-full rounded-3xl border px-4 py-3 text-left transition ${changed ? 'border-violet-400/30 bg-violet-500/10' : 'border-white/10 bg-white/4 hover:bg-white/6'}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{memoTypeLabels[memoType]}</p>
                      {changed ? <Badge variant="info">{t('workflowExpectedPathsChanged')}</Badge> : <Badge variant="outline">{t('workflowExpectedPathsUnchanged')}</Badge>}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowDryRunLive')}</p>
                        <p className="mt-2 text-sm text-[color:var(--operator-foreground)]">{formatPreviewPath(livePreview.steps)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowDryRunDraft')}</p>
                        <p className="mt-2 text-sm text-[color:var(--operator-foreground)]">{draftWorkflow.rules ? formatPreviewPath(draftPreview.steps) : t('workflowDraftInvalidShort')}</p>
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
                <ShieldCheck className="size-4 text-[color:var(--operator-primary-soft)]" />
                <div>
                  <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowRolloutChecklistTitle')}</h2>
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowRolloutChecklistBody')}</p>
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
                <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  {t('workflowDraftInvalidBody', { error: draftWorkflow.error })}
                </div>
              ) : !hasDraftChanges ? (
                <div className="rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
                  {t('workflowRolloutNoChanges')}
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-foreground)]">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.dryRun} onChange={(event) => setRolloutChecklist((prev) => ({ ...prev, dryRun: event.target.checked }))} />
                    <span>{t('workflowRolloutChecklistDryRun')}</span>
                  </label>
                  <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-foreground)]">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.expectedPaths} onChange={(event) => setRolloutChecklist((prev) => ({ ...prev, expectedPaths: event.target.checked }))} />
                    <span>{t('workflowRolloutChecklistExpectedPaths')}</span>
                  </label>
                  <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-foreground)]">
                    <input type="checkbox" className="mt-0.5 size-4" checked={rolloutChecklist.recoveryPlan} onChange={(event) => setRolloutChecklist((prev) => ({ ...prev, recoveryPlan: event.target.checked }))} />
                    <span>{t('workflowRolloutChecklistRecovery')}</span>
                  </label>
                </>
              )}

              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
                {rollbackSnapshot?.items.length
                  ? t('workflowRolloutRollbackReady')
                  : t('workflowRolloutRollbackMissing')}
              </div>
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
                {savedRules.length > 0 ? t('workflowRolloutDisableReady') : t('workflowRolloutDisableEmpty')}
              </div>
              <Badge variant={canRollout ? 'info' : 'outline'}>{canRollout ? t('workflowRolloutReady') : t('workflowRolloutBlocked')}</Badge>
            </SectionCardBody>
          </SectionCard>
        </div>

        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <Ban className="size-4 text-amber-300" />
              <div>
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowEmergencyTitle')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowEmergencyBody')}</p>
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

        <div className="space-y-4 lg:hidden">
          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center gap-2">
                <Smartphone className="size-4 text-[color:var(--operator-primary-soft)]" />
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowMobileTitle')}</h2>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowMobileBody')}</p>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowDesktopHint')}</p>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowPriorityTitle')}</h2>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {edges.length === 0 ? (
                <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowPriorityEmpty')}</p>
              ) : edges.map((edge, index) => {
                const summary = getEdgeSummary(edge, graph, members);
                return (
                  <div key={edge.id} className="rounded-2xl border border-white/10 bg-white/4 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">#{index + 1} {getMemberLabel(summary.source)} → {getMemberLabel(summary.target)}</p>
                        <p className="mt-1 text-xs text-[color:var(--operator-muted)]">
                          {formatMemoTypes(summary.memoTypes)}
                          {' · '}
                          {getActionLabel(edge.action)}
                        </p>
                      </div>
                      <Badge variant="chip">{summary.target?.type === 'agent' ? t('workflowMembersAgents') : t('workflowHumanBadge')}</Badge>
                    </div>
                  </div>
                );
              })}
            </SectionCardBody>
          </SectionCard>
        </div>

        <div className="hidden gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowTemplatesTitle')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowTemplatesBody')}</p>
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
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowMembersTitle')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowMembersBody')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                    <Bot className="size-3.5" /> {t('workflowMembersAgents')}
                  </div>
                  <div className="space-y-2">
                    {agentMembers.map((member) => (
                      <button
                        key={member.id}
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData(EDGE_DATA_MIME, member.id)}
                        onClick={() => addMemberNode(member.id)}
                        className="w-full rounded-2xl border border-white/10 bg-white/4 px-3 py-3 text-left transition hover:bg-white/8"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{member.name}</p>
                            <p className="text-xs text-[color:var(--operator-muted)]">{member.role ?? t('workflowMembersAgents')}</p>
                          </div>
                          <Plus className="size-4 text-[color:var(--operator-primary-soft)]" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                    <User className="size-3.5" /> {t('workflowMembersHumans')}
                  </div>
                  <div className="space-y-2">
                    {humanMembers.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-white/10 px-3 py-3 text-sm text-[color:var(--operator-muted)]">{t('workflowNoHumans')}</p>
                    ) : humanMembers.map((member) => (
                      <button
                        key={member.id}
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData(EDGE_DATA_MIME, member.id)}
                        onClick={() => addMemberNode(member.id)}
                        className="w-full rounded-2xl border border-white/10 bg-white/4 px-3 py-3 text-left transition hover:bg-white/8"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{member.name}</p>
                            <p className="text-xs text-[color:var(--operator-muted)]">{member.role ?? t('workflowHumanBadge')}</p>
                          </div>
                          <Plus className="size-4 text-[color:var(--operator-primary-soft)]" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-dashed border-white/10 px-3 py-3 text-xs text-[color:var(--operator-muted)]">
                  {t('workflowDragHint')}
                </div>
              </SectionCardBody>
            </SectionCard>
          </div>

          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowCanvasTitle')}</h2>
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowCanvasBody')}</p>
                </div>
                {connectionSourceId ? (
                  <Button variant="glass" size="sm" onClick={() => setConnectionSourceId(null)}>{tc('cancel')}</Button>
                ) : null}
              </div>
            </SectionCardHeader>
            <SectionCardBody>
              <div
                ref={canvasRef}
                onDragOver={(event) => event.preventDefault()}
                onDrop={onCanvasDrop}
                className="relative min-h-[620px] overflow-hidden rounded-[28px] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top,_rgba(104,137,255,0.18),_transparent_48%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.9))]"
              >
                <svg className="absolute inset-0 h-full w-full">
                  <defs>
                    <marker id="workflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                    </marker>
                  </defs>
                  {edges.map((edge, index) => renderEdgeLabel(edge, index))}
                </svg>

                {nodes.length === 0 ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                    <Badge variant="chip">{t('workflowEmptyBadge')}</Badge>
                    <h3 className="text-lg font-semibold text-white">{t('workflowEmptyTitle')}</h3>
                    <p className="max-w-md text-sm text-slate-300">{t('workflowEmptyBody')}</p>
                  </div>
                ) : null}

                {connectionSourceId ? (
                  <div className="absolute left-4 top-4 z-20 rounded-2xl border border-violet-400/30 bg-violet-500/15 px-4 py-2 text-sm text-violet-100 backdrop-blur">
                    {t('workflowConnectMode')}
                  </div>
                ) : null}

                {nodes.map((node) => {
                  const member = memberMap.get(node.memberId) ?? fallbackMember;
                  const isConnectionSource = connectionSourceId === node.id;
                  const isAgent = member.type === 'agent';
                  return (
                    <div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      className={`absolute w-44 rounded-3xl border px-4 py-3 text-left shadow-2xl transition ${isConnectionSource ? 'border-violet-400 bg-violet-500/20 text-white' : 'border-white/12 bg-slate-900/85 text-slate-100'} ${!node.locked ? 'cursor-grab active:cursor-grabbing' : ''}`}
                      style={{ left: node.x, top: node.y }}
                      onClick={() => handleNodeSelect(node.id)}
                      onPointerDown={(event) => (!node.locked ? startDragging(event, node.id) : undefined)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleNodeSelect(node.id);
                        }
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            {member.type === 'agent' ? <Bot className="size-4 text-[color:var(--operator-primary-soft)]" /> : <User className="size-4 text-emerald-300" />}
                            <p className="text-sm font-semibold">{member.isSynthetic ? t('workflowOriginalAssignee') : member.name}</p>
                          </div>
                          <p className="mt-2 text-xs text-slate-300">{member.isSynthetic ? t('workflowOriginalAssigneeHint') : member.role ?? (member.type === 'agent' ? t('workflowMembersAgents') : t('workflowHumanBadge'))}</p>
                        </div>
                        {!node.locked ? (
                          <button data-node-action="true" type="button" className="rounded-full p-1 text-slate-300 transition hover:bg-white/10 hover:text-white" onClick={(event) => { event.stopPropagation(); removeNode(node.id); }}>
                            <Trash2 className="size-4" />
                          </button>
                        ) : null}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3 text-xs">
                        <button data-node-action="true" type="button" className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 transition hover:bg-white/10" onClick={(event) => { event.stopPropagation(); startConnection(node.id); }}>
                          <Link2 className="size-3.5" /> {t('workflowNodeConnect')}
                        </button>
                        <Badge variant={isAgent ? 'info' : 'chip'}>{isAgent ? t('workflowMembersAgents') : t('workflowHumanBadge')}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCardBody>
          </SectionCard>

          <div className="space-y-4">
            <SectionCard>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowPriorityTitle')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('workflowPriorityBody')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-2">
                {edges.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-white/10 px-3 py-3 text-sm text-[color:var(--operator-muted)]">{t('workflowPriorityEmpty')}</p>
                ) : edges.map((edge, index) => {
                  const summary = getEdgeSummary(edge, graph, members);
                  const isSelected = edge.id === selectedEdgeId;
                  return (
                    <div
                      key={edge.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => focusEdge(edge.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          focusEdge(edge.id);
                        }
                      }}
                      className={`w-full rounded-2xl border px-3 py-3 text-left transition ${isSelected ? 'border-violet-400/40 bg-violet-500/12' : 'border-white/10 bg-white/4 hover:bg-white/7'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">#{index + 1} {getMemberLabel(summary.source)} → {getMemberLabel(summary.target)}</p>
                          <p className="mt-1 text-xs text-[color:var(--operator-muted)]">
                            {formatMemoTypes(summary.memoTypes)}
                            {' · '}
                            {getActionLabel(edge.action)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" className="rounded-full p-1 text-[color:var(--operator-muted)] transition hover:bg-white/10 hover:text-[color:var(--operator-foreground)]" onClick={(event) => { event.stopPropagation(); moveEdge(edge.id, -1); }}>
                            <ArrowUp className="size-4" />
                          </button>
                          <button type="button" className="rounded-full p-1 text-[color:var(--operator-muted)] transition hover:bg-white/10 hover:text-[color:var(--operator-foreground)]" onClick={(event) => { event.stopPropagation(); moveEdge(edge.id, 1); }}>
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
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('workflowEdgeConfigTitle')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{selectedEdge ? t('workflowEdgeConfigBody') : t('workflowNoEdgeSelected')}</p>
              </SectionCardHeader>
              <SectionCardBody className="space-y-4">
                {selectedEdge && selectedEdgeSummary ? (
                  <>
                    <div className="rounded-2xl border border-white/10 bg-white/4 px-3 py-3">
                      <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{getMemberLabel(selectedEdgeSummary.source)} → {getMemberLabel(selectedEdgeSummary.target)}</p>
                      <p className="mt-1 text-xs text-[color:var(--operator-muted)]">{selectedEdgeSummary.target?.type === 'agent' ? t('workflowForwardAgentHint') : t('workflowHumanTargetHint')}</p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowActionLabel')}</label>
                      <select
                        value={selectedEdge.action}
                        onChange={(event) => updateSelectedEdge({ action: event.target.value as WorkflowEdge['action'] })}
                        className="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-[color:var(--operator-foreground)]"
                      >
                        <option value="process_and_report">{t('workflowActionReport')}</option>
                        <option value="process_and_forward">{t('workflowActionForward')}</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <label className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('workflowMemoTypesLabel')}</label>
                        <button type="button" className="text-xs text-[color:var(--operator-primary-soft)] hover:underline" onClick={() => updateSelectedEdge({ memoTypes: [] })}>{t('workflowAllMemoTypes')}</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {WORKFLOW_MEMO_TYPE_OPTIONS.map((memoType) => {
                          const checked = selectedEdge.memoTypes.includes(memoType);
                          return (
                            <label key={memoType} className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm transition ${checked ? 'border-violet-400/40 bg-violet-500/12 text-[color:var(--operator-foreground)]' : 'border-white/10 bg-white/4 text-[color:var(--operator-muted)]'}`}>
                              <input
                                type="checkbox"
                                className="size-4 rounded border-white/10"
                                checked={checked}
                                onChange={() => updateSelectedEdge({
                                  memoTypes: checked
                                    ? selectedEdge.memoTypes.filter((value) => value !== memoType)
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
          </div>
        </div>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
