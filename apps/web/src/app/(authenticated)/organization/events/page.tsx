'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { EventDefinerForm } from '@/components/organization/event-definer-form';
import {
  type DefinerFormState, deriveDefinition, emptyFormState, tryReverseParse, validateKeySuffix,
} from '@/components/organization/event-definer-logic';

// story #2664 — 목록(GET) 응답 모델(events.py EventDefinitionResponse)엔 아직 id가 없다
// (BE #2663, PR#3069 재QA 중). id가 없는 항목은 수정/비활성 버튼을 아예 안 그린다 — #2663가
// 머지되는 순간 이 화면은 코드 변경 없이 그 즉시 전 항목에서 수정/비활성이 열린다(forward-compat).
interface EventDefinition {
  id?: string;
  key: string;
  org_id: string | null;
  payload_schema: Record<string, unknown>;
  routing: Record<string, unknown>;
  block_template: Record<string, unknown> | null;
  action_auth?: Record<string, unknown> | null;
  enabled: boolean;
  version: number;
}

const DEFAULT_PAYLOAD_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}';
const DEFAULT_ROUTING = '{\n  "escalation": { "kind": "server_derived", "target": "none" },\n  "broadcast": { "kind": "server_derived", "target": "none" }\n}';

// PO 리뷰(PR#3070) 기록사항① — raw SyntaxError 영문을 그대로 보여주지 않는다(#2552 사람말
// 에러 카피 원칙). 어느 필드가 깨졌는지(field) 호출부가 t('eventJsonParseError', {field})로
// 로컬라이즈해 보여줄 수 있게 field만 실어 던진다.
class JsonFieldParseError extends Error {
  constructor(public field: string) { super(`invalid_json:${field}`); }
}

function parseJsonField(raw: string, field: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new JsonFieldParseError(field);
  }
}

export default function OrganizationEventsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug ?? '';
  const isAdmin = currentRole === 'admin' || currentRole === 'owner';
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  const { toasts, addToast, dismissToast } = useToast();

  const [defs, setDefs] = useState<EventDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EventDefinition | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<EventDefinition | null>(null);
  const [publishTarget, setPublishTarget] = useState<EventDefinition | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/events/definitions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as EventDefinition[] | { data?: EventDefinition[] };
      setDefs(Array.isArray(json) ? json : (json.data ?? []));
    } catch (error) {
      addToast({ type: 'error', title: t('eventErrorGeneric'), body: error instanceof Error ? error.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [addToast, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const presetDefs = defs.filter((d) => d.org_id === null);
  const customDefs = defs.filter((d) => d.org_id !== null);

  const deactivate = async (def: EventDefinition) => {
    if (!def.id) return;
    setDeactivateTarget(null);
    try {
      const res = await fetch(`/api/events/definitions/${def.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? body?.detail?.message ?? `HTTP ${res.status}`);
      }
      addToast({ type: 'success', title: t('eventDeactivateSuccessToast') });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: t('eventErrorGeneric'), body: error instanceof Error ? error.message : undefined });
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{t('eventsTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('eventsDescription')}</p>
        </div>
        {isAdmin ? (
          <Button onClick={() => setCreateOpen(true)}>{t('eventCreateCta')}</Button>
        ) : null}
      </div>

      {!isAdmin ? (
        <p className="text-sm text-muted-foreground">{t('eventReadonlyNotAdmin')}</p>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : (
        <>
          <SectionCard>
            <SectionCardHeader>
              <h2 className="text-base font-semibold text-foreground">
                {t('eventsCustomGroupTitle')} ({customDefs.length})
              </h2>
            </SectionCardHeader>
            <SectionCardBody>
              {customDefs.length > 0 ? (
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {customDefs.map((def) => (
                    <EventDefRow
                      key={def.key}
                      def={def}
                      expanded={expandedKey === def.key}
                      onToggleExpand={() => setExpandedKey((k) => (k === def.key ? null : def.key))}
                      readonly={false}
                      isAdmin={isAdmin}
                      onEdit={() => setEditTarget(def)}
                      onDeactivate={() => setDeactivateTarget(def)}
                      onTestPublish={() => setPublishTarget(def)}
                      t={t}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('eventsEmpty')}</p>
              )}
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <h2 className="text-base font-semibold text-foreground">
                {t('eventsPresetGroupTitle')} ({presetDefs.length})
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('eventsPresetReadonlyNote')}</p>
            </SectionCardHeader>
            <SectionCardBody>
              {presetDefs.length > 0 ? (
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {presetDefs.map((def) => (
                    <EventDefRow
                      key={def.key}
                      def={def}
                      expanded={expandedKey === def.key}
                      onToggleExpand={() => setExpandedKey((k) => (k === def.key ? null : def.key))}
                      readonly
                      isAdmin={isAdmin}
                      t={t}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('eventsEmpty')}</p>
              )}
            </SectionCardBody>
          </SectionCard>
        </>
      )}

      <EventFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgSlug={orgSlug}
        onSaved={async () => { await refresh(); }}
        t={t}
        tc={tc}
        addToast={addToast}
      />

      <EventFormDialog
        mode="edit"
        target={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        orgSlug={orgSlug}
        onSaved={async () => { setEditTarget(null); await refresh(); }}
        t={t}
        tc={tc}
        addToast={addToast}
      />

      <ConfirmDialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}
        title={t('eventDeactivateDialogTitle')}
        description={t('eventDeactivateDialogBody', { key: deactivateTarget?.key ?? '' })}
        cancelLabel={tc('cancel')}
        confirmLabel={t('eventDeactivateConfirmCta')}
        onConfirm={() => { if (deactivateTarget) void deactivate(deactivateTarget); }}
      />

      <TestPublishDialog
        target={publishTarget}
        open={publishTarget !== null}
        onOpenChange={(open) => { if (!open) setPublishTarget(null); }}
        t={t}
        tc={tc}
        addToast={addToast}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function EventDefRow({
  def, expanded, onToggleExpand, readonly, isAdmin, onEdit, onDeactivate, onTestPublish, t,
}: {
  def: EventDefinition;
  expanded: boolean;
  onToggleExpand: () => void;
  readonly: boolean;
  isAdmin: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
  onTestPublish?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // story #2664 — id 없는(구 목록 API, #2663 머지 전) 항목은 수정/비활성 버튼을 숨긴다(그릴 수
  // 없는 액션을 보여주는 게 UX상 더 나쁘다) — id가 실리는 순간 자동으로 나타난다.
  const canMutate = !readonly && isAdmin && !!def.id;
  return (
    <div className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleExpand}
              className="truncate font-mono text-sm text-foreground hover:underline"
            >
              {def.key}
            </button>
            <Badge variant={def.enabled ? 'success' : 'secondary'}>
              {def.enabled ? t('eventEnabledBadge') : t('eventDisabledBadge')}
            </Badge>
            <Badge variant="outline">{t('eventVersionLabel', { version: def.version })}</Badge>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {!readonly && isAdmin ? (
            <Button size="sm" variant="ghost" disabled={!def.enabled} onClick={onTestPublish}>
              {t('eventTestPublishCta')}
            </Button>
          ) : null}
          {canMutate ? (
            <>
              <Button size="sm" variant="outline" onClick={onEdit}>{t('eventEditCta')}</Button>
              {def.enabled ? (
                <Button size="sm" variant="destructive" onClick={onDeactivate}>{t('eventDeactivateCta')}</Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2">
          <JsonPreview label={t('eventPayloadSchemaLabel')} value={def.payload_schema} />
          <JsonPreview label={t('eventRoutingLabel')} value={def.routing} />
          {def.block_template ? <JsonPreview label={t('eventBlockTemplateLabel')} value={def.block_template} /> : null}
          {/* PR#3087 — 이 조회 자체가 BE org admin/owner 게이트라, 일반 멤버는 조회하면
              항상 403이라 아예 안 그린다(모두가 여는 매 행마다 헛된 실패 fetch 방지). */}
          {isAdmin ? <PublishHistorySection definitionKey={def.key} t={t} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function JsonPreview({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs text-foreground">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

// story #2665 — PR#3087(디디) 응답 계약 그대로 소비. 신규 로그 테이블 없이
// conversation_messages SSOT 재조회라 정의 하나당 별도 fetch(펼칠 때만 — 목록 전체 N+1 방지).
interface PublishHistoryItem {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string | null;
  created_at: string;
}

type PublishHistoryState = { kind: 'loading' } | { kind: 'resolved'; items: PublishHistoryItem[] } | { kind: 'error' };

function PublishHistorySection({ definitionKey, t }: { definitionKey: string; t: ReturnType<typeof useTranslations> }) {
  const locale = useLocale();
  const [state, setState] = useState<PublishHistoryState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`/api/events/definitions/publish-history?definition_key=${encodeURIComponent(definitionKey)}&limit=20`);
        if (!res.ok) throw new Error();
        const items = await res.json() as PublishHistoryItem[];
        if (!cancelled) setState({ kind: 'resolved', items });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [definitionKey]);

  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t('eventPublishHistoryLabel')}</p>
      {state.kind === 'loading' ? (
        <p className="text-xs text-muted-foreground">{t('eventPublishHistoryLoading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-xs text-destructive">{t('eventPublishHistoryError')}</p>
      ) : state.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('eventPublishHistoryEmpty')}</p>
      ) : (
        <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-2">
          {state.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-foreground">{item.sender_name ?? t('eventPublishHistoryUnknownSender')}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {new Date(item.created_at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
                <Link href={`/chats/${item.conversation_id}`} className="text-primary hover:underline">
                  {t('eventPublishHistoryOpenChat')}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventFormDialog({
  mode, target, open, onOpenChange, orgSlug, onSaved, t, tc, addToast,
}: {
  mode: 'create' | 'edit';
  target?: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  onSaved: () => Promise<void>;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const { currentTeamMemberId } = useDashboardContext();
  const prefix = `org.${orgSlug || '{org}'}.`;
  const [keySuffix, setKeySuffix] = useState('');
  const [payloadSchema, setPayloadSchema] = useState(DEFAULT_PAYLOAD_SCHEMA);
  const [routing, setRouting] = useState(DEFAULT_ROUTING);
  const [blockTemplate, setBlockTemplate] = useState('');
  const [humanOnly, setHumanOnly] = useState(false);
  const [rolesCsv, setRolesCsv] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // story #2670(A층) — 「기본」(3서식 폼) / 「고급」(JSON, #3070 원안) 탭. create=항상 기본
  // 시작. edit=기존 JSON을 tryReverseParse로 되돌려 성공하면 기본, 실패(폼이 못 만드는
  // 모양)하면 고급 전용(배지+기본 탭 비활성) — AC3 그대로.
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const [definerState, setDefinerState] = useState<DefinerFormState>(emptyFormState());
  const [advancedOnly, setAdvancedOnly] = useState(false);
  // 새로 저장한 정의의 실 key(발행 테스트가 필요로 하는 서버측 실체) — create 저장 성공
  // 직후에도 다이얼로그를 닫지 않고 이 값을 채워 그 자리에서 바로 테스트 발행까지 잇는다
  // (스펙 §4 "정의→미리보기→테스트 발행"이 한 세션 안에서 끊기지 않아야 함).
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [testPublishing, setTestPublishing] = useState(false);
  const [testPublishResult, setTestPublishResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && target) {
      setKeySuffix(target.key.startsWith(`org.${orgSlug}.`) ? target.key.slice(`org.${orgSlug}.`.length) : target.key);
      setPayloadSchema(JSON.stringify(target.payload_schema, null, 2));
      setRouting(JSON.stringify(target.routing, null, 2));
      setBlockTemplate(target.block_template ? JSON.stringify(target.block_template, null, 2) : '');
      const auth = target.action_auth as { human_only?: boolean; role?: string[] } | null | undefined;
      setHumanOnly(auth?.human_only ?? false);
      setRolesCsv((auth?.role ?? []).join(', '));

      const parsed = orgSlug ? tryReverseParse(target.key, target.payload_schema, target.routing, target.action_auth ?? null, orgSlug, target.block_template) : null;
      if (parsed) { setDefinerState(parsed); setTab('basic'); setAdvancedOnly(false); }
      else { setDefinerState(emptyFormState()); setTab('advanced'); setAdvancedOnly(true); }
      setSavedKey(target.key);
    } else {
      setKeySuffix('');
      setPayloadSchema(DEFAULT_PAYLOAD_SCHEMA);
      setRouting(DEFAULT_ROUTING);
      setBlockTemplate('');
      setHumanOnly(false);
      setRolesCsv('');
      setDefinerState(emptyFormState());
      setTab('basic');
      setAdvancedOnly(false);
      setSavedKey(null);
    }
    setTestPublishResult(null);
    setError(null);
  }, [open, mode, target, orgSlug]);

  const definerKeyError = tab === 'basic' && mode === 'create' ? validateKeySuffix(definerState.keySuffix) : null;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (tab === 'basic') {
        if (definerKeyError) throw new Error(definerKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset'));
        const derived = deriveDefinition(definerState, orgSlug);
        body = {
          payload_schema: derived.payload_schema,
          routing: derived.routing,
          block_template: derived.block_template,
          action_auth: derived.action_auth,
        };
        if (mode === 'create') body.key = derived.key;
      } else {
        const roles = rolesCsv.split(',').map((r) => r.trim()).filter(Boolean);
        const actionAuth = humanOnly || roles.length > 0 ? { human_only: humanOnly, role: roles } : null;
        body = {
          payload_schema: parseJsonField(payloadSchema, t('eventPayloadSchemaLabel')),
          routing: parseJsonField(routing, t('eventRoutingLabel')),
          block_template: blockTemplate.trim() ? parseJsonField(blockTemplate, t('eventBlockTemplateLabel')) : null,
          action_auth: actionAuth,
        };
        if (mode === 'create') body.key = `${prefix}${keySuffix.trim()}`;
      }
      let res: Response;
      if (mode === 'create') {
        res = await fetch('/api/events/definitions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        if (!target?.id) throw new Error(t('eventErrorGeneric'));
        res = await fetch(`/api/events/definitions/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const resBody = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(resBody?.error?.message ?? resBody?.detail?.message ?? `HTTP ${res.status}`);
      }
      // POST /api/events/definitions는 raw passthrough(proxyToFastapi, apiSuccess로 안 감쌈)라
      // BE(EventDefinitionDetailResponse)를 그대로 준다 — {data:...}가 아니다. 다만 이 계층
      // (fastapi-proxy)이 훗날 wrapped로 바뀌어도 조용히 깨지지 않게 두 형태 다 받는다
      // (오늘 세션 gate undo/discuss와 같은 방어 패턴).
      const savedRaw = await res.json().catch(() => null) as { data?: { key?: string }; key?: string } | null;
      const savedKeyValue = savedRaw?.data?.key ?? savedRaw?.key;
      addToast({ type: 'success', title: mode === 'create' ? t('eventCreateSuccessToast') : t('eventEditSuccessToast') });
      await onSaved();
      if (mode === 'create' && savedKeyValue) {
        // 다이얼로그를 안 닫는다 — 저장 즉시 테스트 발행이 가능해야 §4의 "정의→미리보기→
        // 테스트 발행" 한 흐름이 끊기지 않는다(재오픈 왕복 없음).
        setSavedKey(savedKeyValue);
      } else {
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testPublish = async () => {
    if (!savedKey) return;
    setTestPublishing(true);
    setTestPublishResult(null);
    try {
      const derived = deriveDefinition(definerState, orgSlug);
      // PO 라이브 실측(review_changes) — 「발행할 때 지정」routing(payload_field)은 BE가
      // payload[member_id_field]에 실 멤버 id를 요구한다. 순수 파생 샘플엔 그 필드가 없어
      // 테스트 발행이 "나에게만 보내는 실 발행"(§4 약속)을 어기고 항상 실패했다 — 지금
      // 로그인한 나(currentTeamMemberId)를 여기서 채워 보낸다(파생 로직 자체는 순수 유지).
      const broadcast = derived.routing.broadcast as { kind?: string; member_id_field?: string } | undefined;
      const publishPayload = broadcast?.kind === 'payload_field' && broadcast.member_id_field && currentTeamMemberId
        ? { ...derived.samplePayload, [broadcast.member_id_field]: currentTeamMemberId }
        : derived.samplePayload;
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: savedKey, payload: publishPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setTestPublishResult({ ok: false, message: body?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setTestPublishResult({ ok: true });
    } catch {
      setTestPublishResult({ ok: false, message: t('eventErrorGeneric') });
    } finally {
      setTestPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{mode === 'create' ? t('eventCreateDialogTitle') : t('eventEditDialogTitle')}</DialogTitle>
            <div className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
              <button
                type="button"
                disabled={advancedOnly}
                onClick={() => setTab('basic')}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tab === 'basic' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {t('definerTabBasic')}
              </button>
              <button
                type="button"
                onClick={() => setTab('advanced')}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${tab === 'advanced' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {t('definerTabAdvanced')}
                {advancedOnly ? <Badge variant="warning" className="ml-1 text-[9px]">{t('definerAdvancedOnlyBadge')}</Badge> : null}
              </button>
            </div>
          </div>
          {tab === 'advanced' ? <DialogDescription>{t('eventKeyPrefixHint')}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-1">
          {tab === 'basic' ? (
            <EventDefinerForm
              state={definerState}
              onChange={setDefinerState}
              orgSlug={orgSlug}
              testPublish={() => void testPublish()}
              testPublishing={testPublishing}
              testPublishResult={savedKey ? testPublishResult : { ok: false, message: t('definerTestPublishSaveFirst') }}
            />
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="event-key">
                  {t('eventKeyLabel')}
                </label>
                {mode === 'create' ? (
                  <div className="flex items-center gap-1">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{prefix}</span>
                    <Input id="event-key" value={keySuffix} onChange={(e) => setKeySuffix(e.target.value)} className="font-mono text-sm" />
                  </div>
                ) : (
                  <Input id="event-key" value={target?.key ?? ''} readOnly disabled className="font-mono text-sm" />
                )}
              </div>
              <JsonField id="event-payload-schema" label={t('eventPayloadSchemaLabel')} value={payloadSchema} onChange={setPayloadSchema} />
              <JsonField id="event-routing" label={t('eventRoutingLabel')} value={routing} onChange={setRouting} />
              <JsonField id="event-block-template" label={`${t('eventBlockTemplateLabel')} (${tc('optional')})`} value={blockTemplate} onChange={setBlockTemplate} />
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={humanOnly} onChange={(e) => setHumanOnly(e.target.checked)} className="size-4" />
                  {t('eventActionAuthHumanOnlyLabel')}
                </label>
                <Input
                  value={rolesCsv}
                  onChange={(e) => setRolesCsv(e.target.value)}
                  placeholder={t('eventActionAuthRolePlaceholder')}
                  className="text-sm"
                />
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" aria-live="assertive" className="mt-3 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {mode === 'create' && savedKey ? tc('close') /* 저장 후엔 닫기만 남는다(재저장=중복 POST·409 방지) */ : tc('cancel')}
          </Button>
          {mode === 'create' && savedKey ? null : (
            <Button
              onClick={() => void submit()}
              disabled={saving || (tab === 'advanced' ? mode === 'create' && !keySuffix.trim() : !!definerKeyError)}
            >
              {saving ? '...' : mode === 'create' ? t('eventCreateSubmit') : t('eventEditSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

function TestPublishDialog({
  target, open, onOpenChange, t, tc, addToast,
}: {
  target: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const [payload, setPayload] = useState('{}');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setPayload('{}'); setError(null); }
  }, [open]);

  const submit = async () => {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const parsedPayload = parseJsonField(payload, t('eventTestPublishPayloadLabel'));
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: target.key, payload: parsedPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? body?.detail?.message ?? `HTTP ${res.status}`);
      }
      addToast({ type: 'success', title: t('eventTestPublishSuccessToast') });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!sending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('eventTestPublishDialogTitle')}</DialogTitle>
          <DialogDescription>{target?.key ?? ''}</DialogDescription>
        </DialogHeader>
        <JsonField id="event-test-publish-payload" label={t('eventTestPublishPayloadLabel')} value={payload} onChange={setPayload} />
        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={sending}>{sending ? '...' : t('eventTestPublishSubmit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
