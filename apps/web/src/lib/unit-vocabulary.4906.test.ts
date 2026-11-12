// @vitest-environment node
//
// story 4906 ⑩ (PO decision 11-12 [B]) — the AREA is «일감/Work»; the UNIT is «스토리/Story». The strings that name ONE story must say «스토리» (ko) / «story · stories» (en): a reader sees one
// thing under one name. «첫 일감을 맡겨요»-style desktop setup lines hand a TASK to an agent (not a story) and are not pinned here.
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const UNIT_KEYS: Array<[string, string, string]> = [
  // [key path, ko must contain, en must contain]
  ['home.kindStory', '스토리', 'Story'],
  ['workList.emptyStateTitle', '스토리', 'stories'],
  ['workList.emptyStateFilteredTitle', '스토리', 'Nothing matches'],
  ['organization.definerPreviewSampleWorkItem', '스토리', 'story'],
  ['board.originNotCollected', '스토리', 'stories'],
];
const get = (d: unknown, path: string): string => path.split('.').reduce((o, k) => (o as Record<string, unknown>)[k], d) as string;

describe('story 4906 ⑩ [B] — the unit is «스토리/Story», the area is «일감/Work»', () => {
  it.each(UNIT_KEYS)('%s names the unit as a story (ko says «스토리» and not «일감»; en says story/stories and not «work item»)', (key, koHas, enHas) => {
    const k = get(ko, key);
    const e = get(en, key);
    expect(k).toContain(koHas);
    expect(k).not.toContain('일감');
    expect(e).toContain(enHas);
    expect(e.toLowerCase()).not.toContain('work item');
  });

  it('the AREA name stays «일감» / «Work» (nav zone + the list page title)', () => {
    expect(get(ko, 'nav.zoneDev')).toBe('일감');
    expect(get(en, 'nav.zoneDev')).toBe('Work');
    expect(get(ko, 'workList.title')).toBe('일감');
    expect(get(en, 'workList.title')).toBe('Work');
  });
});
