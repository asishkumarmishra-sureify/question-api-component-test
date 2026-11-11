/**
 * NAAP — core journey specs: product selection, quote page, Policy Information.
 * Authoring rules: sureify_ids + labels only. No UUIDs. No request bodies.
 *
 * Path exercised:
 *   load_application -> status 'products' (one product_card)
 *   selectProduct()  -> status 'quote'    (Standard_Quote_DND page 1: contact details)
 *   continue()       -> status 'questions' (Standard_Application_DND, breadcrumb "Policy Information")
 */
import { test, expect } from '../fixtures/acquire';
import data from '../test-data/naap-happy-path.json';

test.describe('NAAP — pilot', () => {

  test('product selection moves the application from products to quote', async ({ acquire }) => {
    const app = await acquire.startApplication();
    expect(app.status, 'fresh application opens on the products page').toBe('products');

    const quotePage = await app.selectProduct(data.product);

    expect(app.status, 'after product selection').toBe('quote');
    await quotePage.expectNoErrors();
    await quotePage.expectEchoConsistent();
    await quotePage.expectQuestions({ visible: ['Full.Name', 'Insured.EmailId'] });
  });

  test('option labels resolve against the live tree (fails fast on drift)', async ({ acquire }) => {
    const app = await acquire.startApplication();
    await app.selectProduct(data.product);
    const product = app.adm['ProductsQuestion'] as { id?: string; label?: string };
    expect(product?.id, 'product answer carries the live option id').toBeTruthy();
    expect(product?.label).toBe(data.product);
  });

  test('quote contact page submits clean and opens the application questionnaire', async ({ acquire }) => {
    const app = await acquire.startApplication();
    await app.selectProduct(data.product);

    await app.answerPage(data.quoteContact);
    const policyPage = await app.continue();

    expect(app.status, 'quote complete → application questionnaire').toBe('questions');
    await policyPage.expectNoErrors();
    await policyPage.expectEchoConsistent();
    await policyPage.expectBreadcrumbTitle('Policy Information');
    await policyPage.expectQuestions({ visible: ['Basic.First', 'Basic.Last', 'Basic.Dob'] });
  });

  test('policy information page submits clean and advances', async ({ acquire }) => {
    const app = await acquire.startApplication();
    await app.selectProduct(data.product);
    await app.answerPage(data.quoteContact);
    await app.continue();

    await app.answerPage(data.policyInformation);
    const next = await app.continue();

    await next.expectNoErrors();
    await next.expectEchoConsistent();
    await next.expectBreadcrumbTitle(/remain/i);        // "Policy Information" -> "Remaining Details"
    await next.expectAdmPersisted();
  });

  test('engine rejects a missing required field', async ({ acquire }) => {
    const app = await acquire.startApplication();
    await app.selectProduct(data.product);
    await app.answerPage(data.quoteContact);
    await app.continue();

    const { ['Basic.Last']: _omit, ...partial } = data.policyInformation;
    await app.answerPage(partial);
    const result = await app.continue();

    await result.expectQuestionError('Basic.Last', /required/i);
  });
});
