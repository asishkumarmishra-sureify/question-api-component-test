/**
 * NAAP — complete Insured transaction, products through the e-signature stage.
 *
 * Verified on NAAP stg (2026-10-13), role Insured:
 *   products -> quote -> Policy Information -> Remainaing Details -> Primary Physician
 *   -> Tobacco Use -> signature page (status 'signature', two consent labels, nothing to answer)
 *   -> next_page returns the e-signature response: status 'e-signature', no questionnaire,
 *      no breadcrumbs, no ADM echo, plus the esign payload (applicable_forms, input_json,
 *      signature_info). That payload is what the browser hands to Concordia to fill the PDF,
 *      so it is the furthest point reachable through the question API alone. It is visible in
 *      the report as the JSON attachment of the last call.
 * The beneficiary stage and the agent medical page belong to other roles and are not on this path.
 * Authoring rules: sureify_ids + labels only. No UUIDs. No engine changes.
 */
import { test, expect } from '../fixtures/acquire';
import type { ApplicationSession } from '../src/engine/ApplicationSession';
import happy from '../test-data/naap-happy-path.json';
import journey from '../test-data/naap-full-journey.json';

async function openRemainingDetails(acquire: { startApplication(): Promise<ApplicationSession> }) {
  const app = await acquire.startApplication();
  await app.selectProduct(happy.product);
  await app.answerPage(happy.quoteContact);
  await app.continue();
  await app.answerPage(happy.policyInformation);
  const page = await app.continue();
  await page.expectNoErrors();
  await page.expectBreadcrumbTitle(/remain/i);
  return app;
}

test.describe('NAAP — complete Insured transaction', () => {

  test('Insured completes every page and reaches the e-signature stage', async ({ acquire }) => {
    const app = await openRemainingDetails(acquire);

    await app.answerPage(journey.remainingDetails);
    const physician = await app.continue();
    await physician.expectNoErrors();
    await physician.expectEchoConsistent();
    await physician.expectBreadcrumbTitle('Primary Physician');

    await app.answerPage(journey.primaryPhysician);
    const tobacco = await app.continue();
    await tobacco.expectNoErrors();
    await tobacco.expectEchoConsistent();
    await tobacco.expectBreadcrumbTitle('Tobacco Use');

    await app.answerPage(journey.tobaccoUse);
    const signature = await app.continue();
    await signature.expectNoErrors();
    await signature.expectEchoConsistent();
    expect(app.status, 'all question pages done → signature page').toBe('signature');
    const states = app.tree.allBreadcrumbs().map(b => b.state);
    expect(states.filter(s => s === 'completed'), 'four question breadcrumbs completed').toHaveLength(4);
    expect(states.filter(s => s === 'active'), 'the signature breadcrumb is active').toHaveLength(1);
    await signature.expectQuestions({ visible: ['Econsent.Auth1', 'Econsent.Auth2'] });

    // Nothing to answer on the consent page: continuing starts the e-signature stage.
    const esign = await app.continue();
    expect(app.status, 'signature page submitted → e-signature stage').toBe('e-signature');
    await esign.expectNoErrors();
    await esign.expectAdmPersisted();
    for (const sid of ['Basic.First', 'About.Networth', 'Physician.Details', 'Tobacco.TobUasge']) {
      expect(app.adm[sid], `${sid} is still in the ADM at the e-signature stage`).toBeDefined();
    }
  });

  test('net worth above the cap is rejected on Remaining Details', async ({ acquire }) => {
    const app = await openRemainingDetails(acquire);

    await app.answerPage({ ...journey.remainingDetails, ...journey.netWorthAboveCap });
    const page = await app.continue();

    await page.expectBreadcrumbTitle(/remain/i);
    await page.expectQuestionError('About.Networth', /more than 100000/i);
  });
});
