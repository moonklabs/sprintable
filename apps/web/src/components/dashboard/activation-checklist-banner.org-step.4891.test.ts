// story 4891 (PO ④ · «나») — the setup band's third line is already done for everyone who sees the band: the organization is made with the sign-up itself, so «Create an organization» /
// «조직 만들기» read as an errand the person never did and could not do (measured on dev, web + phone width). The line stays (the count stays 3/5) and says what is true: it is made.
// Reverting either word turns this red.
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

const act = (m: unknown) => (m as { activation: Record<string, string> }).activation;

describe('activation band — «organization» step wording (story 4891)', () => {
  it('says the organization is made, not an errand to do', () => {
    expect(act(en).stepOrgCreated).toBe('Your organization is created');
    expect(act(ko).stepOrgCreated).toBe('조직이 만들어졌어요');
    expect(act(en).stepOrgCreated).not.toMatch(/^Create /);
    expect(act(ko).stepOrgCreated).not.toContain('만들기');
  });

  it('the other four steps keep their words (the count and the rest of the band do not move)', () => {
    expect(act(en).stepSignedUp).toBe('Sign up');
    expect(act(en).stepEmailVerified).toBe('Verify your email');
    expect(act(en).stepAgentConnected).toBe('Connect an agent');
    expect(act(en).stepFirstRoundtrip).toBe('Send an instruction and get a reply');
  });
});
