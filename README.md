# question-api-component-test

API-level component tests for the AAA NAAP Acquire **question API**, written in
Playwright + TypeScript. Tests drive
acquire application through the same `/api/questions` conversation with event types, and assert on what the server returns.

- [What this framework is](#what-this-framework-is)
- [What it can do today](#what-it-can-do-today)
- [Setup and running](#setup-and-running)
- [Repository layout](#repository-layout)
- [Authoring a test](#authoring-a-test)
- [Managing test data](#managing-test-data)
- [Rebuilding the question catalog](#rebuilding-the-question-catalog)
- [Troubleshooting](#troubleshooting)

---

## What this framework is

The Acquire question API is a **server-driven conversation**: each response
defines the next request. Question ids, option ids, breadcrumbs and the
application data model (ADM) all come from the previous response. A test cannot
replay a recorded request body, because the ids inside it are minted per
application.

This framework therefore has two halves:

1. **A journey engine** (`src/engine/ApplicationSession.ts`) that holds the
   conversation. It sends `load_application`, ingests the reply, lets the test
   answer questions by name, sends `next_page`, ingests again, and so on. Every
   outgoing request is built only from the immediately preceding response.
2. **A business-language authoring layer.** Specs and test data refer to
   questions by their Acquire Studio `sureify_id` (for example `Basic.Dob`) and
   to choices by their visible label (for example `Florida`). The engine resolves
   these against the live response at run time. **No question UUID or option UUID
   ever appears in a spec or test-data file.** This is enforced by review.

A generated **catalog** (`catalog/naap.questions.json`, built from Acquire Studio
exports) acts as an authoring guardrail: a sureify_id that is not in the catalog
fails the test before any request is sent.

Every API call is attached to the Playwright HTML report as decoded JSON, nested
under a named step such as `Continue from "Policy Information" (next_page)`, so a
failure can be read without a trace viewer.

Detailed diagrams of the loop live in [docs/sequence-diagram.md](docs/sequence-diagram.md).

## What it can do today

Verified green against NAAP staging (Acquire v2.5.20), 12 tests in about 30 s:

- **Full Insured journey**: products → quote → Policy Information → Remaining
  Details → Primary Physician → Tobacco Use → signature page → e-signature stage.
  The e-sign payload (forms, input JSON, signature info) is the furthest point the
  question API reaches; PDF generation and signing happen in Concordia, outside
  this API.
- **Product selection** by label, located on the live tree by display type.
- **Answering** text, date, number, currency and option questions by sureify_id,
  with option labels resolved to live `{id, label}` objects.
- **Validation assertions**: a specific question is `invalid` with a matching
  message, or the whole page is error-free.
- **Navigation assertions**: active breadcrumb by title or id, application status
  (`products`, `quote`, `questions`, `signature`, `e-signature`).
- **Reflexive (conditional) questions on a single page**, any depth and fan-out.
  Proven on the Florida financial-professional chain: a child becomes required when
  its parent condition is met, is marked `absent` and pruned from the ADM when it
  is not, and the prune is persisted.
- **Catalog guardrails**: unknown sureify_ids, unknown option labels and questions
  not on the current page fail fast with a message naming the fix.

`CLAUDE.md` keeps the running list of what has been verified against live traffic
and what is still assumed.

## Setup and running

```bash
npm i && npx playwright install
cp .env.example .env     # fill in the NAAP staging URL and Cognito M2M credentials
npm run test:dev         # all specs against staging
```

Useful variants:

```bash
npm run test:dev -- tests/naap-reflexive.spec.ts   # one file
npm run test:dev -- -g "product selection"          # one test by title
npm run report                                      # open the HTML report
```

Do not use bare `npm test` or `npx playwright test`; both also run the `harness`
project, which fails with `ECONNREFUSED` on port 8080.

`.env` is git-ignored and must only ever point at an allowlisted **non-production**
NAAP environment. Never point it at production.

## Repository layout

| Path | Purpose |
|---|---|
| `src/client/` | Cognito client-credentials auth, envelope decoding, endpoint wrappers. Endpoint and auth differences live only here. |
| `src/engine/ApplicationSession.ts` | The ingest loop: `start`, `selectProduct`, `answer`, `answerPage`, `continue`, `triggerApi`, `list`. |
| `src/engine/QuestionTree.ts` | Flattened, indexed view of one response; label-to-option resolution. |
| `src/engine/Oracles.ts` | `PageAssertions`: every `expect*` method a spec can call. |
| `src/engine/ListBuilder.ts` | List sub-loop. **Known broken**, see above. |
| `src/catalog/` + `catalog/naap.questions.json` | Authoring guardrails generated from Studio exports. Never hand-edit the JSON. |
| `catalog/exports/` | Raw Acquire Studio exports, one per questionnaire. |
| `fixtures/acquire.ts` | Playwright fixture that wires auth, client, catalog and report attachments; exposes `acquire.startApplication()`. |
| `tests/` | Specs. Business language only. |
| `test-data/` | Answer sets keyed by sureify_id. Business language only. |
| `docs/` | Sequence diagrams and the reflexive-question assessment. |

## Authoring a test

### The shape of a spec

```ts
import { test, expect } from '../fixtures/acquire';
import happy from '../test-data/naap-happy-path.json';

test('policy information page submits clean and advances', async ({ acquire }) => {
  const app = await acquire.startApplication();          // load_application → status 'products'
  await app.selectProduct(happy.product);                 // next_page → status 'quote'
  await app.answerPage(happy.quoteContact);
  await app.continue();                                   // next_page → status 'questions'

  await app.answerPage(happy.policyInformation);
  const page = await app.continue();                      // returns PageAssertions

  await page.expectNoErrors();
  await page.expectEchoConsistent();
  await page.expectBreadcrumbTitle(/remain/i);
});
```

Every test starts a brand-new application. Tests do not share state, so they can
run in parallel.

### Rules

1. **Names, never ids.** Use sureify_ids and option labels exactly as Acquire Studio
   shows them. Label matching is case-insensitive but otherwise exact.
2. **Answer only what the server is currently showing.** `answer` and `answerPage`
   throw if the question is not in the current tree. A reflexive child revealed by
   a parent answer on the *same* page can be answered in the same `answerPage`
   call, because NAAP serves every child alongside its parent. A question on a
   *later* page needs a `continue()` first.
3. **One `continue()` per page.** It serialises the server's last ADM plus your
   answers, sends `next_page`, ingests the reply and returns a `PageAssertions`
   bound to that reply.
4. **Assert through `PageAssertions`.** Do not reach into raw responses. The engine
   exposes `app.status`, `app.adm` and `app.tree` for the occasional targeted
   check, as the reflexive spec does with `isAbsent`.
5. **Keep helpers in the spec.** A shared "open page X" helper at the top of the
   file is the pattern used by `naap-full-journey.spec.ts` and
   `naap-reflexive.spec.ts`.

### Engine methods

| Call | What it does |
|---|---|
| `acquire.startApplication()` | `load_application`; returns the session on the products page. |
| `app.selectProduct(label?)` | Picks the product card option by label, or the only one offered, then continues. |
| `app.answer(sid, value)` | Resolves and stages one answer. Catalog-checked. |
| `app.answerPage({ sid: value, ... })` | Same for a map of answers. |
| `app.continue()` | Sends `next_page`, ingests, returns `PageAssertions`. |
| `app.triggerApi(sid, value)` | Sends `page_state_change` for a trigger_api question. Body unverified. |
| `app.completePageWithDefaults()` | Fills visible unanswered questions from catalog defaults. Over-fills reflexives. |

### Assertions on the returned page

| Call | Checks |
|---|---|
| `expectNoErrors()` | No question on the page has status `invalid`. |
| `expectQuestionError(sid, /regex/?)` | That question is `invalid`, optionally with a matching message. |
| `expectQuestions({ visible, hidden, absent })` | Presence and `is_hidden` by sureify_id. For reflexives use status, not `hidden`. |
| `expectBreadcrumbTitle(string \| RegExp)` | Active breadcrumb title as the server labels it. |
| `expectBreadcrumb(id)` / `expectStillOn(id)` | Active breadcrumb by id. |
| `expectEchoConsistent()` | Every answer just sent is in the ADM echo, allowing reflexive pruning. |
| `expectAdmPersisted({ ignore? })` | A fresh GET of the ADM matches the session ADM. |

### Writing a negative test

Send the bad value, continue, and assert both that the journey did not advance
and that the right question carries the error:

```ts
await app.answerPage({ ...journey.remainingDetails, 'About.Networth': '250000' });
const page = await app.continue();
await page.expectBreadcrumbTitle(/remain/i);
await page.expectQuestionError('About.Networth', /more than 100000/i);
```

### Writing a reflexive test

Answer the parent and the children in one `answerPage`, continue, then assert on
the children's status or on their presence in `app.adm`. See
`tests/naap-reflexive.spec.ts` for the five patterns: chain accepted, child
required when revealed, parent required when revealed, children pruned when parent
is `No`, whole chain pruned when the grandparent condition is unmet.

## Managing test data

Test data lives in `test-data/*.json`, one file per concern, and is imported
directly into specs. Each file is a plain object of answer blocks.

```json
{
  "_comment": "What this file covers, when it was verified, and any traps.",
  "product": "Standard_Quote_DND",
  "quoteContact": { "Full.Name": "Avery Quinn", "Insured.EmailId": "avery.quinn@example.com" },
  "policyInformation": { "Basic.State": "California", "Basic.Dob": "04/12/1985", "Basic.Ssn": "123-45-6789" }
}
```

Conventions:

- **Keys are sureify_ids, values are strings.** Option answers are the visible
  label. The engine turns them into the server's object form.
- **One block per page or per scenario.** Blocks are composed in the spec with
  object spread: `{ ...happy.policyInformation, ...reflexive.floridaResident }`.
  Later blocks override earlier keys, which is how a scenario file tweaks one or
  two answers on top of the happy path.
- **Formats** verified on staging: dates `MM/DD/YYYY`, SSN `NNN-NN-NNNN`, phone
  and currency as digit strings.
- **Omit questions whose condition is unmet.** Do not include a reflexive child
  unless the parent answer in the same block reveals it. The server will prune it,
  but the test data should say what you mean.
- **Document the trap in `_comment`.** Caps, formats and reflexive triggers that
  were discovered the hard way belong there, with the date they were verified.
- **No UUIDs, no request bodies, no recorded responses.** If you need a value you
  can only get from a live response, the engine should resolve it at run time.
- **Synthetic people only.** Never put real customer data in test data.

Current files:

| File | Covers |
|---|---|
| `naap-happy-path.json` | Product, quote contact page, Policy Information for a California resident. |
| `naap-full-journey.json` | Remaining Details, Primary Physician, Tobacco Use, and a net-worth-over-cap variant. |
| `naap-reflexive.json` | The Florida financial-professional chain in composable blocks. |

## Rebuilding the question catalog

When the questionnaire is reseeded or a new version is exported from Acquire Studio:

1. Drop the raw exports into `catalog/exports/`. One journey spans two
   questionnaires (quote, then application), so export both.
2. Rebuild one merged catalog:
   ```bash
   npm run catalog:naap
   # or, for different file names:
   npm run catalog -- catalog/exports/<Quote>.json catalog/exports/<Application>.json
   ```
3. Review the diff of `catalog/naap.questions.json`. It lists exactly which
   sureify_ids, option labels and reflexive conditions changed.
4. Update test data and specs for renamed ids or labels, then run `npm run test:dev`.
   The engine fails at the first mismatch and names what is wrong.
5. Commit the regenerated catalog together with the data and spec changes.

The catalog is consulted only as a guard and for default fills. No request is ever
built from it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `HTTP 403` with an HTML body mentioning Cloudflare on `load_application` | The staging host's Cloudflare rule is blocking your network. Send the Ray ID from the attached response to the Cloudflare admin, or run from the office network or VPN. |
| `ECONNREFUSED ::1:8080` | You ran the `harness` project. Use `npm run test:dev`. |
| `sureify_id "X" is not in the NAAP catalog` | Typo, or the catalog needs a rebuild after a new export. |
| `"X" is not in the current question tree` | The question is on another page, or its reflexive parent is not answered. |
| `Option "X" not found on Y. Available: ...` | Label drift. Use one of the labels listed. |
| `Cognito token request failed` | Check the token URL, client id, secret and scope in `.env`. |
| `Expected exactly one product_card question` | The application is not on the products page. Check `app.status`. |
