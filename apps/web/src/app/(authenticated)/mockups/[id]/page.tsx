'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorSelect } from '@/components/ui/operator-control';
import { EmptyState } from '@/components/ui/empty-state';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { ChevronRight } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface MockupComponent {
  id: string;
  parent_id: string | null;
  component_type: string;
  props: Record<string, unknown>;
  spec_description: string | null;
  sort_order: number;
}

interface Scenario {
  name: string;
  overrides: Record<string, Record<string, unknown>>;
  is_default?: boolean;
}

interface MockupData {
  id: string;
  title: string;
  viewport: string;
  version: number;
  components: MockupComponent[];
  scenarios?: Scenario[];
}

export default function MockupViewerPage() {
  const t = useTranslations('mockup');
  const params = useParams();
  const [mockup, setMockup] = useState<MockupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeScenario, setActiveScenario] = useState<string>('');

  useEffect(() => {
    fetch(`/api/mockups/${params.id}`).then((r) => r.ok ? r.json() : null).then((json) => {
      if (json?.data) setMockup(json.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [params.id]);

  const selectedComponent = mockup?.components.find((c) => c.id === selectedId) ?? null;
  const components = mockup?.components ?? [];
  const scenarios = mockup?.scenarios ?? [];
  const currentScenario = scenarios.find((s) => s.name === activeScenario);

  function getComponentProps(comp: MockupComponent): Record<string, unknown> {
    if (!currentScenario) return comp.props;
    const override = currentScenario.overrides[comp.id];
    return override ? { ...comp.props, ...override } : comp.props;
  }

  function getChildren(parentId: string | null) {
    return components.filter((c) => c.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order);
  }

  function renderComponent(comp: MockupComponent): React.ReactNode {
    const children = getChildren(comp.id);
    const isSelected = comp.id === selectedId;
    const props = getComponentProps(comp);
    const style: React.CSSProperties = {
      ...(props as React.CSSProperties),
      outline: isSelected ? '2px solid var(--operator-primary)' : undefined,
      outlineOffset: isSelected ? '2px' : undefined,
      cursor: 'pointer',
      transition: 'all 150ms ease',
    };

    return (
      <div
        key={comp.id}
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          setSelectedId(comp.id);
        }}
      >
        {typeof props?.text === 'string' ? <span>{props.text}</span> : null}
        {children.map((child) => renderComponent(child))}
      </div>
    );
  }

  if (loading) return <PageSkeleton />;
  if (!mockup) return <div className="py-12"><EmptyState title={t('noMockups')} /></div>;

  const rootComponents = getChildren(null);
  const isMobile = mockup.viewport === 'mobile';

  return (
    <div className="space-y-4">
      <TopBarSlot
        title={
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-muted-foreground">{t('title')}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <h1 className="text-sm font-medium">{mockup.title}</h1>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">{mockup.viewport === 'mobile' ? t('mobile') : t('desktop')}</Badge>
            <Badge variant="info">v{mockup.version}</Badge>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard>
          <SectionCardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('title')}</div>
              {scenarios.length > 0 ? (
                <OperatorSelect
                  value={activeScenario}
                  onChange={(e) => setActiveScenario(e.target.value)}
                  className="text-xs"
                >
                  <option value="">{t('defaultScenario')}</option>
                  {scenarios.filter((s) => !s.is_default).map((scenario) => <option key={scenario.name} value={scenario.name}>{scenario.name}</option>)}
                </OperatorSelect>
              ) : null}
            </div>
          </SectionCardHeader>
          <SectionCardBody>
            <div className="rounded-3xl border border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4" onClick={() => setSelectedId(null)}>
              <div className={`mx-auto bg-white text-black shadow-lg ${isMobile ? 'w-[375px] rounded-[2rem] border-4 border-gray-800 p-4' : 'w-full max-w-4xl rounded-2xl p-6'}`}>
                {rootComponents.length === 0 ? (
                  <div className="py-16 text-center text-sm text-gray-400">{t('noMockups')}</div>
                ) : (
                  rootComponents.map((comp) => renderComponent(comp))
                )}
              </div>
            </div>
          </SectionCardBody>
        </SectionCard>

        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{selectedComponent?.component_type ?? t('selectComponent')}</div>
              <Button variant="glass" size="sm" onClick={() => setSelectedId(null)} disabled={!selectedComponent}>✕</Button>
            </div>
          </SectionCardHeader>
          <SectionCardBody>
            {selectedComponent ? (
              <div className="space-y-4">
                {selectedComponent.spec_description ? (
                  <div className="prose prose-sm max-w-none text-[color:var(--operator-muted)] prose-headings:text-[color:var(--operator-foreground)] prose-strong:text-[color:var(--operator-foreground)] prose-p:text-[color:var(--operator-muted)] prose-li:text-[color:var(--operator-muted)]">
                    <ReactMarkdown>{selectedComponent.spec_description}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-[color:var(--operator-muted)]">{t('noSpec')}</p>
                )}
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('props')}</h4>
                  <pre className="mt-2 overflow-x-auto rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/55 p-3 text-xs text-[color:var(--operator-foreground)]">{JSON.stringify(getComponentProps(selectedComponent), null, 2)}</pre>
                </div>
              </div>
            ) : (
              <EmptyState title={t('selectComponent')} />
            )}
          </SectionCardBody>
        </SectionCard>
      </div>
    </div>
  );
}
