/**
 * NAAP — reflexive (conditional) questions, Policy Information page.
 * Chain under test (depth 2, fan-out 3), all served on one page:
 *   Basic.State = Florida  -> Basic.Finpro becomes applicable (required)
 *   Basic.Finpro = Yes     -> Basic.Finproname, Basic.Finemail, Basic.Finphn become applicable (required)
 * Engine behaviour verified on NAAP stg: unmet children are marked `absent` and
 * their ADM entries are pruned; met-but-empty required children are `invalid`.
 * Authoring rules: sureify_ids + labels only. No UUIDs. No engine changes.
 */
import { test, expect } from '../fixtures/acquire';
import type { ApplicationSession } from '../src/engine/ApplicationSession';
import happy from '../test-data/naap-happy-path.json';
import reflexive from '../test-data/naap-reflexive.json';

const details = reflexive.financialProfessionalDetails;

async function openPolicyInformation(acquire: { startApplication(): Promise<ApplicationSession> }) {
  const app = await acquire.startApplication();
  await app.selectProduct(happy.product);
  await app.answerPage(happy.quoteContact);
  await app.continue();
  return app;
}

test.describe('NAAP — reflexive questions (financial professional chain)', () => {

  test('Florida resident with a financial professional: the whole chain is accepted and kept', async ({ acquire }) => {
    const app = await openPolicyInformation(acquire);

    await app.answerPage({ ...happy.policyInformation, ...reflexive.floridaResident, ...reflexive.financialProfessional });
    const next = await app.continue();

    await next.expectNoErrors();
    await next.expectBreadcrumbTitle(/remain/i);
    await next.expectEchoConsistent();
    for (const sid of ['Basic.Finpro', ...details]) {
      expect(app.adm[sid], `${sid} survives in the server ADM echo`).toBeDefined();
    }
    await next.expectAdmPersisted();
  });

  test('Finpro = Yes without the follow-up details is rejected on each detail', async ({ acquire }) => {
    const app = await openPolicyInformation(acquire);

    await app.answerPage({ ...happy.policyInformation, ...reflexive.floridaResident, 'Basic.Finpro': 'Yes' });
    const page = await app.continue();

    await page.expectBreadcrumbTitle('Policy Information');
    for (const sid of details) await page.expectQuestionError(sid, /required/i);
    expect(app.tree.bySureifyId('Basic.Finpro')?.status, 'the parent itself is valid').toBe('valid');
  });

  test('Florida resident who skips Finpro is rejected (revealed question is required)', async ({ acquire }) => {
    const app = await openPolicyInformation(acquire);

    await app.answerPage({ ...happy.policyInformation, ...reflexive.floridaResident });
    const page = await app.continue();

    await page.expectBreadcrumbTitle('Policy Information');
    await page.expectQuestionError('Basic.Finpro', /required/i);
    for (const sid of details) {
      expect(app.tree.bySureifyId(sid)?.isAbsent, `${sid} is not applicable while Finpro is unanswered`).toBe(true);
    }
  });

  test('Finpro = No makes the follow-up details not applicable even if answered', async ({ acquire }) => {
    const app = await openPolicyInformation(acquire);

    const overfilled = { ...reflexive.financialProfessional, ...reflexive.noFinancialProfessional };
    await app.answerPage({ ...happy.policyInformation, ...reflexive.floridaResident, ...overfilled });
    const next = await app.continue();

    await next.expectNoErrors();
    await next.expectBreadcrumbTitle(/remain/i);
    await next.expectEchoConsistent();
    expect((app.adm['Basic.Finpro'] as { label?: string })?.label, 'the parent answer is kept').toBe('No');
    for (const sid of details) expect(app.adm[sid], `${sid} is pruned from the ADM`).toBeUndefined();
    const stored = await app.client.getApplicationDataModel(app.uid);
    for (const sid of details) expect(stored[sid], `${sid} is not persisted either`).toBeUndefined();
  });

  test('Outside Florida the whole financial-professional chain is pruned', async ({ acquire }) => {
    const app = await openPolicyInformation(acquire);

    // happy path is a California resident; answer the Florida-only chain anyway
    await app.answerPage({ ...happy.policyInformation, ...reflexive.financialProfessional });
    const next = await app.continue();

    await next.expectNoErrors();
    await next.expectBreadcrumbTitle(/remain/i);
    await next.expectEchoConsistent();
    for (const sid of ['Basic.Finpro', ...details]) expect(app.adm[sid], `${sid} is pruned from the ADM`).toBeUndefined();
    const stored = await app.client.getApplicationDataModel(app.uid);
    for (const sid of ['Basic.Finpro', ...details]) expect(stored[sid], `${sid} is not persisted either`).toBeUndefined();
  });
});
