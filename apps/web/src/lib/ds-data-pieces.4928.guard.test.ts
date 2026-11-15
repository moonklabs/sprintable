// story 4928 — the «data pieces» register. ds Chip · StatusLabel · ListRow subtitle are body font by default; the places below hand the fixed-width font
// to a DATA piece on purpose (a model name · a key · a time · an e-mail · a host name · a count with a unit). If someone drops the mark, the piece goes
// back to the body font silently — so each call site is pinned here. (Render tests cover the parts themselves in `components/ds/*.test.tsx`.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const PINS: Array<[string, string, string]> = [
  // [file, exact text that must stay, what it is]
  ['app/(authenticated)/organization/generation-connectors/page.tsx', '<Chip mono>{c.provider_key}</Chip>', 'provider key chip'],
  ['app/(authenticated)/organization/generation-connectors/page.tsx', '<Chip mono data-testid="gc-location-chip">{c.location}</Chip>', 'region chip'],
  ['app/(authenticated)/organization/workforce/[id]/page.tsx', '<Chip mono tone="info">SSE</Chip>', 'SSE chip'],
  ['app/(authenticated)/rewards/page.tsx', '<Chip mono>#{i + 1}</Chip>', 'rank chip'],
  ['app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', '<Chip mono icon="schedule">{selected.capacity} SP</Chip>', 'capacity chip'],
  ['app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', '<DataText>{sprint.start_date} ~ {sprint.end_date}</DataText>', 'sprint dates'],
  ['components/organization/generation-connector-register-form.tsx', '<Chip mono>vertex_gemini</Chip>', 'provider key chip'],
  ['components/agents/agent-performance-panel.tsx', '<Chip mono>#{agent.rank}</Chip>', 'rank chip'],
  ['components/agents/agent-performance-panel.tsx', '<Chip mono>{agent.balance} TJSB</Chip>', 'balance chip'],
  ['components/agents/agent-run-detail.tsx', '<Chip mono>{run.model}</Chip>', 'model chip'],
  ['components/agents/agent-run-detail.tsx', '<Chip mono>{run.trigger}</Chip>', 'trigger chip'],
  ['components/canvas/artifact-viewer.tsx', '<Chip mono>{artifact.format}</Chip>', 'format chip'],
  ['components/loops/artifact-preview.tsx', '<Chip mono className="uppercase">{subtype}</Chip>', 'content-type chip'],
  ['components/agents/agent-api-key-manager.tsx', '<Chip mono key={s}', 'scope chips'],
  ['components/agents/agent-management-tab.tsx', '<DataText key="device">{agent.device_name}</DataText>', 'computer name in the second line'],
  ['components/agents/agent-runs-list.tsx', "const data = (key: string, text: string | null | undefined) => (text ? <DataText key={key}>{text}</DataText> : null);", 'run meta data pieces'],
  ['components/agents/agent-runs-list.tsx', "data('model', run.model)", 'run model'],
  ['components/agents/agent-runs-list.tsx', "data('tokens',", 'run tokens'],
  ['app/(authenticated)/organization/roles/page.tsx', 'subtitle={member.email ? <DataText>{member.email}</DataText> : undefined}', 'member e-mail'],
  ['app/(authenticated)/organization/events/page.tsx', '<DataText data-testid={`event-def-key-subtitle-${def.key}`}>{def.key}</DataText>', 'event key'],
  ['app/(authenticated)/content/page.tsx', '<DataText>v{draft.current_version}</DataText>', 'version number'],
  ['app/(authenticated)/[ws]/[proj]/loops/loops-client.tsx', '<DataText key="recipe">{loop.recipe_slug}</DataText>', 'recipe slug'],
];

// the three «other» places that were fixed-width Korean text: now body font + tabular-nums
const BODY_FONT_PINS: Array<[string, string]> = [
  ['components/home/home-list.tsx', 'className="m-0 px-4 py-2 font-sans text-ds-mono-md tabular-nums text-ds-ink-3" data-testid="home-header-line"'],
  ['app/(authenticated)/[ws]/[proj]/goals/goals-head.tsx', '<span className="font-sans text-ds-mono-md tabular-nums text-ds-ink-3">{t(\'indexCountActive\''],
  ['app/(authenticated)/[ws]/[proj]/docs/docs-index.tsx', 'font-sans tabular-nums text-ds-mono-md text-ds-ink-3">{formatDate('],
];

describe('4928 data pieces stay fixed-width where the caller marked them', () => {
  for (const [file, text, what] of PINS) {
    it(`${what} — ${file}`, () => { expect(read(file), `${file}: ${what}`).toContain(text); });
  }
});

describe('4928 Korean text that used to be fixed-width stays body font', () => {
  for (const [file, text] of BODY_FONT_PINS) {
    it(file, () => { expect(read(file)).toContain(text); });
  }
  it('home header line · goals count · docs dates are not font-mono any more', () => {
    expect(read('components/home/home-list.tsx')).not.toMatch(/font-mono[^"]*"[^>]*data-testid="home-header-line"/);
    expect(read('app/(authenticated)/[ws]/[proj]/goals/goals-head.tsx')).not.toMatch(/font-mono[^>]*>\{t\('indexCountActive'/);
    expect(read('app/(authenticated)/[ws]/[proj]/docs/docs-index.tsx')).not.toMatch(/font-mono[^>]*>\{formatDate\(/);
  });
});
