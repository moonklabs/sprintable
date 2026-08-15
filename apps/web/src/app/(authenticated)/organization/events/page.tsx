'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ToastContainer, useToast } from '@/components/ui/toast';

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

function parseJsonField(raw: string, fallback: null): null;
function parseJsonField(raw: string): Record<string, unknown>;
function parseJsonField(raw: string, fallback?: null): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return fallback ?? {};
  return JSON.parse(trimmed) as Record<string, unknown>;
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
  const prefix = `org.${orgSlug || '{org}'}.`;
  const [keySuffix, setKeySuffix] = useState('');
  const [payloadSchema, setPayloadSchema] = useState(DEFAULT_PAYLOAD_SCHEMA);
  const [routing, setRouting] = useState(DEFAULT_ROUTING);
  const [blockTemplate, setBlockTemplate] = useState('');
  const [humanOnly, setHumanOnly] = useState(false);
  const [rolesCsv, setRolesCsv] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } else {
      setKeySuffix('');
      setPayloadSchema(DEFAULT_PAYLOAD_SCHEMA);
      setRouting(DEFAULT_ROUTING);
      setBlockTemplate('');
      setHumanOnly(false);
      setRolesCsv('');
    }
    setError(null);
  }, [open, mode, target, orgSlug]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const roles = rolesCsv.split(',').map((r) => r.trim()).filter(Boolean);
      const actionAuth = humanOnly || roles.length > 0 ? { human_only: humanOnly, role: roles } : null;
      const body: Record<string, unknown> = {
        payload_schema: parseJsonField(payloadSchema),
        routing: parseJsonField(routing),
        block_template: blockTemplate.trim() ? parseJsonField(blockTemplate) : null,
        action_auth: actionAuth,
      };
      let res: Response;
      if (mode === 'create') {
        body.key = `${prefix}${keySuffix.trim()}`;
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
      addToast({ type: 'success', title: mode === 'create' ? t('eventCreateSuccessToast') : t('eventEditSuccessToast') });
      onOpenChange(false);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('eventCreateDialogTitle') : t('eventEditDialogTitle')}</DialogTitle>
          <DialogDescription>{t('eventKeyPrefixHint')}</DialogDescription>
        </DialogHeader>
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
          {error ? (
            <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={saving || (mode === 'create' && !keySuffix.trim())}>
            {saving ? '...' : mode === 'create' ? t('eventCreateSubmit') : t('eventEditSubmit')}
          </Button>
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
      const parsedPayload = parseJsonField(payload);
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
      setError(e instanceof Error ? e.message : String(e));
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
