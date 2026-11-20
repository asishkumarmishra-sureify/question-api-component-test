/**
 * NAAP product — Agent journey started from the agent panel.
 *
 * Path exercised, role Agent:
 *   cutover ("Initiate > Begin Quote")  -> status 'quote', breadcrumb "Case Setup" (NAAP Product Quote)
 *   Get Your Quote (CalculateButton)    -> quote/spark-quote result stored as the button's answer
 *   continue                            -> status 'questions' (NAAP Product Application), ten question pages:
 *     Proposed Insured Information -> Proposed Owner Information -> Beneficiary Information
 *     -> Existing Insurance -> Proposed Insured Health Information -> HIV Testing Consent
 *     -> Temporary Insurance Agreement -> Secondary Addressee Information -> Premium Payment
 *     -> Agent Supplemental Information
 *   last continue                       -> every page completed; the server offers the hand-off
 *                                          "Pass application to Insured"
 *   passTo('Insured') (role_transition) -> status 'role_switching': the application now waits for
 *                                          the Insured (stage "Insured Terms And Conditions").
 * Beneficiaries are list answers: one primary and one contingent row.
 *
 * Insured stage (a separate session, opened from the launch link the API gives out — no mailbox):
 *   identity check (status 'challenge': date of birth + zip code) -> Terms of Use consent
 *   -> signature page (signing city/state) -> status 'e-signature' -> documents generated and
 *   click-signed through the signing service -> hand-off back to the Agent ("Agent Signature").
 * Authoring rules: sureify_ids + labels only. No UUIDs. No request bodies.
 */
import { test, expect } from '../fixtures/acquire';
import type { AnswerValue, ApplicationSession } from '../src/engine/ApplicationSession';
import data from '../test-data/naap-product-journey.json';

type Acquire = { 
  startFromAgentPanel(agent: Record<string, unknown>): Promise<ApplicationSession> 
};
type Answers = Record<string, AnswerValue>;

const pages = data.pages as Record<string, Answers>;
const pageTitles = Object.keys(pages);

async function openQuote(acquire: Acquire) {
  return acquire.startFromAgentPanel(data.agent);
}

/** Agent fills every page and passes the application to the Insured. */
async function handOffToInsured(acquire: Acquire) {
  const agent = await openApplication(acquire);
  for (const title of pageTitles) {
    await agent.answerPage(pages[title]);
    await agent.continue();
  }
  await agent.passTo(data.handoffRole);
  return agent;
}

async function openApplication(acquire: Acquire) {
  const app = await openQuote(acquire);
  await app.answerPage(data.quote);
  await app.callButtonApi('CalculateButton');
  await app.continue();
  return app;
}

test.describe('NAAP product — Agent journey from the agent panel', () => {

  test('agent-panel start opens the quote page with the agent details filled in', async ({ acquire }) => {
    const app = await openQuote(acquire);

    expect(app.status, 'a new application opens on the quote questionnaire').toBe('quote');
    expect(app.tree.activeBreadcrumbTitle(), 'active breadcrumb').toBe('Case Setup');
    expect(app.adm['Agent.FullName'], 'agent name comes from the agent panel').toBe(data.agent.agentName);
    expect(app.adm['Agent.AgentNumber'], 'agent number comes from the agent panel').toBe(data.agent.agentNumber);
    for (const sid of ['Insured.FirstName', 'Insured.DateOfBirth', 'Quote.TermPeriod', 'Quote.FaceAmount', 'CalculateButton']) {
      expect(app.tree.bySureifyId(sid), `${sid} is on the quote page`).toBeTruthy();
    }
  });

  test('Get Your Quote returns a premium and the quote continues to the application', async ({ acquire }) => {
    const app = await openQuote(acquire);
    await app.answerPage(data.quote);

    const result = await app.callButtonApi('CalculateButton');
    expect(result.response?.success, 'quote calculation succeeded').toBe(true);
    expect(Number(result.response?.quote?.modalPremium), 'a modal premium is quoted').toBeGreaterThan(0);

    const first = await app.continue();
    expect(app.status, 'quote complete → application questionnaire').toBe('questions');
    await first.expectNoErrors();
    await first.expectEchoConsistent();
    await first.expectBreadcrumbTitle(pageTitles[0]);
    expect(Number(app.adm['Quote.Response.ModalPremium']), 'the quoted premium is kept in the ADM').toBeGreaterThan(0);
    expect(app.adm['PolicyInfoPolicyNumber'], 'a policy number is assigned').toBeTruthy();
    const titles = app.tree.allBreadcrumbs().filter(b => b.show !== false).map(b => b.title);
    for (const title of pageTitles.filter(t => t !== 'Temporary Insurance Agreement')) {
      expect(titles, `breadcrumb "${title}" is offered`).toContain(title);
    }
  });

  test('Agent completes every application page and passes the application to the Insured', async ({ acquire }) => {
    const app = await openApplication(acquire);

    let last!: Awaited<ReturnType<ApplicationSession['continue']>>;
    for (const [i, title] of pageTitles.entries()) {
      expect(app.tree.activeBreadcrumbTitle(), `page ${i + 1} of ${pageTitles.length}`).toBe(title);
      await app.answerPage(pages[title]);
      const next = last = await app.continue();
      await next.expectNoErrors();
      await next.expectEchoConsistent();
      if (i < pageTitles.length - 1) await next.expectBreadcrumbTitle(pageTitles[i + 1]);
    }

    const crumbs = app.tree.allBreadcrumbs().filter(b => b.show !== false);
    const notDone = crumbs.slice(0, -1).filter(b => b.state !== 'completed').map(b => `${b.title}:${b.state}`);
    expect(notDone, 'every page before the last is completed').toEqual([]);
    expect(app.handoff, 'the server offers a role hand-off after the last page').toBeTruthy();
    expect(app.handoff!.transition_roles?.map(r => r.name), 'the application passes to the Insured').toContain('Insured');
    expect(app.handoff!.notification_page?.title).toBe('Pass application to Insured');
    for (const list of ['BenePrimary.DesignationsGroup', 'BeneContingent.DesignationsGroup']) {
      expect(app.listRows(list), `${list} still holds its one beneficiary`).toHaveLength(1);
    }
    await last.expectAdmPersisted();

    await app.passTo(data.handoffRole);
    expect(app.status, 'the application now waits for the next role').toBe('role_switching');
    expect(app.tree.bySureifyId('Transition')?.raw.question_text, 'the waiting notice names the next role')
      .toContain(`It can be accessed only by <b> ${data.handoffRole}</b>`);
  });

  test('Insured verifies identity, accepts the terms, signs the documents and passes back to the Agent', async ({ acquire }) => {
    test.setTimeout(420_000);   // document generation is a queued job on the signing service
    const agent = await handOffToInsured(acquire);

    const insured = await agent.openNextRoleSession();
    expect(insured.status, 'the hand-off link opens on an identity check').toBe('challenge');

    await insured.verifyIdentity(data.insured.wrongIdentityCheck);
    expect(insured.status, 'a wrong zip code keeps the identity check up').toBe('challenge');
    expect(insured.identityError).toMatch(/does not match our records/i);

    const terms = await insured.verifyIdentity(data.insured.identityCheck);
    expect(insured.identityError, 'the correct answers are accepted').toBe('');
    expect(insured.role, 'the session acts as the Insured').toBe('Insured');
    expect(insured.uid, 'the Insured has a session of their own').not.toBe(agent.uid);
    await terms.expectQuestions({ visible: ['TermsAndConditionsConsent2'] });
    expect(insured.adm['Insured.SSN'], 'the Agent\'s answers are visible to the Insured').toBe(pages[pageTitles[0]]['Insured.SSN']);

    await insured.answerPage(data.insured.termsOfUse);
    const signaturePage = await insured.continue();
    expect(insured.status, 'terms accepted → signature page').toBe('signature');
    await signaturePage.expectNoErrors();
    await signaturePage.expectQuestions({ visible: ['InsuredSignatureSigningCity', 'InsuredSignatureSigningState'] });

    await insured.answerPage(data.insured.signaturePage);
    await insured.continue();
    expect(insured.status, 'signing city and state given → e-signature stage').toBe('e-signature');
    expect(insured.esign?.signatory_group, 'the signing request is for the Insured').toBe('Insured');
    expect(insured.esign?.applicable_forms?.length, 'forms to sign').toBeGreaterThan(0);

    const { unsignedDocuments, signedDocuments } = await insured.sign();
    expect(unsignedDocuments.length, 'documents were generated for signing').toBeGreaterThan(0);
    expect(signedDocuments.length, 'every document comes back signed').toBe(unsignedDocuments.length);
    for (const doc of signedDocuments) {
      expect(Buffer.from(doc.data.slice(0, 8), 'base64').toString('latin1'), `document ${doc.document_id} is a PDF`).toMatch(/^%PDF/);
    }
    expect(insured.signatureInfo?.envelopeSigned, 'the server records the envelope as signed').toBe(true);
    expect(insured.handoff?.transition_roles?.map(r => r.name), 'the application goes back to the Agent').toContain(data.insured.handoffRole);

    await insured.passTo(data.insured.handoffRole);
    expect(insured.status).toBe('role_switching');
    expect(insured.tree.bySureifyId('Transition')?.raw.question_text, 'the Agent signs next')
      .toContain('<b> Agent Signature</b>');
  });

  test('a cell phone that is not fully formatted is rejected on Proposed Insured Information', async ({ acquire }) => {
    const app = await openApplication(acquire);

    await app.answerPage({ ...pages[pageTitles[0]], 'Insured.CellPhone': '9165550100' });
    const page = await app.continue();

    await page.expectBreadcrumbTitle(pageTitles[0]);
    await page.expectQuestionError('Insured.CellPhone', /at least 14 characters/i);
  });

  test('an employed insured without an occupation is rejected (revealed question is required)', async ({ acquire }) => {
    const app = await openApplication(acquire);

    const { ['Insured.Occupation']: _omit, ...partial } = pages[pageTitles[0]];
    await app.answerPage(partial);
    const page = await app.continue();

    await page.expectBreadcrumbTitle(pageTitles[0]);
    await page.expectQuestionError('Insured.Occupation', /required/i);
  });

  test('a primary beneficiary without a last name is rejected on that row', async ({ acquire }) => {
    const app = await openApplication(acquire);
    for (const title of pageTitles.slice(0, 2)) {
      await app.answerPage(pages[title]);
      await app.continue();
    }

    const [beneficiary] = pages['Beneficiary Information']['BenePrimary.DesignationsGroup'] as Record<string, string>[];
    const { ['BenePrimary.LastName']: _omit, ...withoutLastName } = beneficiary;
    await app.list('BenePrimary.DesignationsGroup').addRecord(withoutLastName);
    const page = await app.continue();

    await page.expectBreadcrumbTitle('Beneficiary Information');
    await page.expectQuestionError('BenePrimary.LastName', /row 1: .*required/i);
  });

  test('insured as owner still needs the owner name and address', async ({ acquire }) => {
    const app = await openApplication(acquire);
    await app.answerPage(pages[pageTitles[0]]);
    await app.continue();

    await app.answerPage({ 'Insured.IsPolicyOwner': 'Yes' });
    const page = await app.continue();

    await page.expectBreadcrumbTitle('Proposed Owner Information');
    for (const sid of ['Owner.FirstName', 'Owner.LastName', 'Owner.AddressLine1', 'Owner.City', 'Owner.State', 'Owner.ZipCode']) {
      await page.expectQuestionError(sid, /required/i);
    }
  });
});
