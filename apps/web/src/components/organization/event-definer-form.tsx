'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, Megaphone, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EventBlockCard } from '@/components/chat/event-block-card';
import {
  type DefinerFormState, type DefinerFormat, type DefinerField, type DefinerStage,
  deriveDefinition, makeId, slugify, validateFieldName, validateKeySuffix,
} from './event-definer-logic';

const FORMATS: { value: DefinerFormat; icon: typeof GitBranch }[] = [
  { value: 'cycle', icon: GitBranch },
  { value: 'signal', icon: Megaphone },
  { value: 'measure', icon: BarChart3 },
];

export function EventDefinerForm({
  state, onChange, orgSlug, testPublish, testPublishing, testPublishResult,
}: {
  state: DefinerFormState;
  onChange: (next: DefinerFormState) => void;
  orgSlug: string;
  testPublish: () => void;
  testPublishing: boolean;
  testPublishResult: { ok: boolean; message?: string } | null;
}) {
  const t = useTranslations('organization');
  const keyError = state.keySuffix ? validateKeySuffix(state.keySuffix) : null;
  const derived = useMemo(() => deriveDefinition(state, orgSlug || '{org}'), [state, orgSlug]);

  const set = <K extends keyof DefinerFormState>(key: K, value: DefinerFormState[K]) => onChange({ ...state, [key]: value });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        {/* ① 서식 */}
        <Section title={t('definerFormatSectionTitle')} hint={t('definerFormatSectionHint')}>
          <div className="grid grid-cols-3 gap-2.5">
            {FORMATS.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => set('format', value)}
                className={`relative rounded-xl border p-3 text-left transition-colors ${state.format === value ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:bg-muted/40'}`}
              >
                {state.format === value ? (
                  <span className="absolute right-2.5 top-2.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">✓</span>
                ) : null}
                <Icon className="mb-1.5 size-5 text-muted-foreground" />
                <p className="text-sm font-semibold text-foreground">{t(`definerFormat_${value}`)}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{t(`definerFormatDesc_${value}`)}</p>
              </button>
            ))}
          </div>
        </Section>

        {/* ② 기본 정보 */}
        <Section title={t('definerBasicSectionTitle')}>
          <FieldLabel htmlFor="definer-name">{t('definerNameLabel')}</FieldLabel>
          <Input id="definer-name" value={state.name} onChange={(e) => set('name', e.target.value)} className="mb-3" />
          <FieldLabel htmlFor="definer-key">{t('definerKeyLabel')}</FieldLabel>
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background pl-3">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{`org.${orgSlug || '{org}'}.`}</span>
            <Input
              id="definer-key"
              value={state.keySuffix}
              onChange={(e) => set('keySuffix', e.target.value)}
              className="border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0"
            />
          </div>
          {keyError ? (
            <p className="mt-1 text-[11px] text-destructive">
              {keyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset')}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">{t('definerKeyHint')}</p>
          )}
        </Section>

        {/* 서식별 섹션 */}
        {state.format === 'cycle' ? (
          <StagesSection stages={state.stages} onChange={(stages) => set('stages', stages)} t={t} />
        ) : state.format === 'signal' ? (
          <SignalSection
            kinds={state.signalKinds}
            includeSummary={state.includeSummary}
            onKindsChange={(v) => set('signalKinds', v)}
            onSummaryChange={(v) => set('includeSummary', v)}
            t={t}
          />
        ) : (
          <MeasureSection
            includeUnit={state.includeMetricUnit}
            includeSource={state.includeSource}
            onUnitChange={(v) => set('includeMetricUnit', v)}
            onSourceChange={(v) => set('includeSource', v)}
            t={t}
          />
        )}

        {/* ④ 받는 사람 */}
        <Section title={t('definerRoutingSectionTitle')} badge={t('definerDerivedBadge')} hint={t('definerRoutingSectionHint')}>
          <RadioRow
            selected={state.routing === 'assign_on_publish'}
            onSelect={() => set('routing', 'assign_on_publish')}
            title={t('definerRoutingAssignTitle')}
            desc={t('definerRoutingAssignDesc')}
          />
          <RadioRow
            selected={state.routing === 'record_only'}
            onSelect={() => set('routing', 'record_only')}
            title={t('definerRoutingRecordTitle')}
            desc={t('definerRoutingRecordDesc')}
          />
          <div className="flex items-start gap-2 rounded-lg border border-border p-2.5 opacity-50">
            <span className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-border" />
            <div>
              <p className="text-xs font-semibold text-foreground">
                {t('definerRoutingStakeholdersTitle')} <Badge variant="warning" className="ml-1 text-[10px]">{t('definerFollowUpBadge')}</Badge>
              </p>
              <p className="text-[11px] text-muted-foreground">{t('definerRoutingStakeholdersDesc')}</p>
            </div>
          </div>
        </Section>

        {/* ⑤ 발행 권한 */}
        <Section title={t('definerAuthSectionTitle')} badge={t('definerDerivedBadge')}>
          <label className="mb-2 flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={state.humanOnly} onChange={(e) => set('humanOnly', e.target.checked)} className="size-4" />
            {t('definerAuthHumanOnlyLabel')}
          </label>
          <FieldLabel htmlFor="definer-roles">{t('definerAuthRolesLabel')}</FieldLabel>
          <Input id="definer-roles" value={state.rolesCsv} onChange={(e) => set('rolesCsv', e.target.value)} placeholder={t('definerAuthRolesPlaceholder')} />
        </Section>

        {/* ⑥ 추가 필드 */}
        <FieldsSection fields={state.fields} onChange={(fields) => set('fields', fields)} t={t} />
      </div>

      {/* 실물 미리보기 */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success shadow-[0_0_0_3px_var(--success-tint)]" />
          {t('definerPreviewLabel')}
        </div>
        <EventBlockCard template={derived.block_template} payload={derived.samplePayload} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2.5 w-full"
          disabled={testPublishing || !!keyError}
          onClick={testPublish}
        >
          {testPublishing ? '...' : t('definerTestPublishCta')}
        </Button>
        {testPublishResult ? (
          <p className={`mt-1.5 text-[11px] font-medium ${testPublishResult.ok ? 'text-success' : 'text-destructive'}`}>
            {testPublishResult.ok ? `✓ ${t('definerTestPublishSuccess')}` : testPublishResult.message}
          </p>
        ) : null}
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">{t('definerPreviewNote')}</p>
        <div className="mt-3 rounded-xl border border-dashed border-border bg-muted/40 p-3">
          <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('definerDerivedSummaryTitle')}</p>
          <DerivedRow label="payload" value={Object.keys(derived.payload_schema.properties as object).join(' · ')} />
          <DerivedRow label="routing" value={state.routing === 'assign_on_publish' ? t('definerRoutingAssignTitle') : t('definerRoutingRecordTitle')} />
          <DerivedRow label="action_auth" value={derived.action_auth ? JSON.stringify(derived.action_auth) : t('definerDerivedNone')} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, badge, hint, children }: { title: string; badge?: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-foreground">
        {title}
        {badge ? <Badge variant="info" className="text-[10px]">{badge}</Badge> : null}
      </h2>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="mb-1 block text-[11px] font-semibold text-muted-foreground">{children}</label>;
}

function RadioRow({ selected, onSelect, title, desc }: { selected: boolean; onSelect: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`mb-1.5 flex w-full items-start gap-2 rounded-lg border p-2.5 text-left ${selected ? 'border-primary bg-primary/5' : 'border-border'}`}
    >
      <span className={`mt-0.5 size-4 shrink-0 rounded-full border-2 ${selected ? 'border-primary bg-primary' : 'border-border'}`} />
      <div>
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
    </button>
  );
}

function DerivedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 py-0.5 font-mono text-[11px] text-foreground">
      <i className="min-w-[70px] shrink-0 not-italic text-muted-foreground">{label}</i>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  );
}

function StagesSection({ stages, onChange, t }: { stages: DefinerStage[]; onChange: (s: DefinerStage[]) => void; t: ReturnType<typeof useTranslations> }) {
  const update = (id: string, patch: Partial<DefinerStage>) => onChange(stages.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (index: number, dir: -1 | 1) => {
    const next = [...stages];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <Section title={t('definerStagesSectionTitle')} badge={t('definerDerivedBadge')} hint={t('definerStagesSectionHint')}>
      <div className="space-y-1.5">
        {stages.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
            <div className="flex flex-col">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="text-muted-foreground disabled:opacity-30" aria-label={t('definerStageMoveUp')}>▲</button>
              <button type="button" disabled={i === stages.length - 1} onClick={() => move(i, 1)} className="text-muted-foreground disabled:opacity-30" aria-label={t('definerStageMoveDown')}>▼</button>
            </div>
            <input
              value={s.name}
              onChange={(e) => {
                const name = e.target.value;
                update(s.id, { name, slug: slugify(name, i) });
              }}
              placeholder={t('definerStageNamePlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            />
            <input
              value={s.slug}
              onChange={(e) => update(s.id, { slug: e.target.value })}
              className="w-32 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground outline-none"
            />
            <button type="button" onClick={() => onChange(stages.filter((x) => x.id !== s.id))} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={t('definerRemoveRow')}>✕</button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...stages, { id: makeId(), name: '', slug: `stage_${stages.length + 1}` }])}
          className="text-xs font-semibold text-primary"
        >
          + {t('definerAddStage')}
        </button>
      </div>
      {stages.length > 0 ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t('definerStagesSlugHint')}</p> : null}
    </Section>
  );
}

function SignalSection({
  kinds, includeSummary, onKindsChange, onSummaryChange, t,
}: {
  kinds: string[]; includeSummary: boolean; onKindsChange: (v: string[]) => void; onSummaryChange: (v: boolean) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Section title={t('definerSignalSectionTitle')} badge={t('definerDerivedBadge')} hint={t('definerSignalSectionHint')}>
      <FieldLabel htmlFor="definer-signal-kinds">{t('definerSignalKindsLabel')}</FieldLabel>
      <Input
        id="definer-signal-kinds"
        value={kinds.join(', ')}
        onChange={(e) => onKindsChange(e.target.value.split(',').map((k) => k.trim()).filter(Boolean))}
        placeholder={t('definerSignalKindsPlaceholder')}
        className="mb-2.5"
      />
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={includeSummary} onChange={(e) => onSummaryChange(e.target.checked)} className="size-4" />
        {t('definerSignalSummaryToggle')}
      </label>
    </Section>
  );
}

function MeasureSection({
  includeUnit, includeSource, onUnitChange, onSourceChange, t,
}: {
  includeUnit: boolean; includeSource: boolean; onUnitChange: (v: boolean) => void; onSourceChange: (v: boolean) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Section title={t('definerMeasureSectionTitle')} badge={t('definerDerivedBadge')} hint={t('definerMeasureSectionHint')}>
      <label className="mb-2 flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={includeUnit} onChange={(e) => onUnitChange(e.target.checked)} className="size-4" />
        {t('definerMeasureUnitToggle')}
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={includeSource} onChange={(e) => onSourceChange(e.target.checked)} className="size-4" />
        {t('definerMeasureSourceToggle')}
      </label>
    </Section>
  );
}

function FieldsSection({ fields, onChange, t }: { fields: DefinerField[]; onChange: (f: DefinerField[]) => void; t: ReturnType<typeof useTranslations> }) {
  const update = (id: string, patch: Partial<DefinerField>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  return (
    <Section title={t('definerFieldsSectionTitle')} badge={t('definerDerivedBadge')} hint={t('definerFieldsSectionHint')}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] font-semibold text-muted-foreground">
              <th className="w-[36%] pb-1">{t('definerFieldNameCol')}</th>
              <th className="w-[26%] pb-1">{t('definerFieldTypeCol')}</th>
              <th className="w-[22%] pb-1">{t('definerFieldRequiredCol')}</th>
              <th className="w-[16%]" />
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const invalid = f.name.trim() !== '' && !validateFieldName(f.name);
              return (
                <tr key={f.id} className="border-t border-border">
                  <td className="py-1 pr-1.5">
                    <input
                      value={f.name}
                      onChange={(e) => update(f.id, { name: e.target.value })}
                      className={`w-full rounded-md border px-1.5 py-1 text-xs ${invalid ? 'border-destructive' : 'border-border'} bg-background text-foreground`}
                    />
                  </td>
                  <td className="py-1 pr-1.5">
                    <select
                      value={f.type}
                      onChange={(e) => update(f.id, { type: e.target.value as DefinerField['type'] })}
                      className="w-full rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                    >
                      <option value="string">{t('definerFieldTypeString')}</option>
                      <option value="number">{t('definerFieldTypeNumber')}</option>
                      <option value="boolean">{t('definerFieldTypeBoolean')}</option>
                      <option value="date">{t('definerFieldTypeDate')}</option>
                    </select>
                  </td>
                  <td className="py-1 pr-1.5">
                    <select
                      value={f.required ? '1' : '0'}
                      onChange={(e) => update(f.id, { required: e.target.value === '1' })}
                      className="w-full rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                    >
                      <option value="1">{t('definerFieldRequired')}</option>
                      <option value="0">{t('definerFieldOptional')}</option>
                    </select>
                  </td>
                  <td className="py-1 text-right">
                    <button type="button" onClick={() => onChange(fields.filter((x) => x.id !== f.id))} className="text-muted-foreground hover:text-destructive" aria-label={t('definerRemoveRow')}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => onChange([...fields, { id: makeId(), name: '', type: 'string', required: false }])}
        className="mt-2 text-xs font-semibold text-primary"
      >
        + {t('definerAddField')}
      </button>
    </Section>
  );
}
