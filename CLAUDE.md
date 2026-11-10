# NAAP API Automation — project conventions for Claude Code

API-level component tests for AAA NAAP's Acquire question API.
Playwright + TypeScript, **no UI automation, no JMeter**.

## The protocol (do not fight it)
The Acquire question API is a server-driven conversation: **response N defines
request N+1**. Question UUIDs, option UUIDs, page_sequence_number, breadcrumbs,
and the application_data_model (ADM) all come from the previous response.
`src/engine/ApplicationSession.ts` implements this as an ingest loop.

## Hard rules (enforced by review; do not relax)
1. **No question UUID or option UUID ever appears in a spec or test-data file.**
   Specs use sureify_ids + human option labels. UUIDs are resolved at runtime
   from the live tree (`QuestionTree.resolveOptionByLabel`).
2. **Every API response flows through `ApplicationSession.ingest()`.**
   Never build a request from anything but the immediately preceding response.
3. **Server echo wins**: on ingest, replace the local ADM with the response's
   `application_data_model`, then overlay new answers. Never merge the other way.
4. All responses are `{code, status, response: base64(JSON)}` — decode only in
   `src/client/envelope.ts`; nothing above the client sees base64.
5. Endpoint/auth differences live ONLY in `src/client/AcquireApiClient.ts`.

## Layout
- `src/client/`  — Cognito auth, envelope decode, endpoint wrappers
- `src/engine/`  — ApplicationSession (ingest loop), QuestionTree, ListBuilder, Oracles
- `src/catalog/` + `catalog/naap.questions.json` — authoring guardrails,
  generated from the Acquire Studio export in `catalog/exports/` (currently
  Standard_Application_DND v0: 113 sureify_ids, 8 sections; the quote
  questionnaire Standard_Quote_DND still needs exporting). Raw exports live in
  `catalog/exports/`, never at the catalog path. Rebuild: `npm run catalog -- <export.json>`
- `tests/`, `test-data/`, `fixtures/` — specs (business language only)

## Verified vs. assumed (resolve the TODOs in this order)
Verified against live NAAP stg traffic (Acquire v2.5.20, 2026-10-09):
- endpoint style: legacy `/api/questions?language=en-US`; auth = Cognito
  client-credentials access token as `Authorization: Bearer` — `AcquireApiClient`, `auth.ts`
- envelope `{code, status, response}` where `response` is a PLAIN JSON object
  (decoder also accepts base64 for older deployments) — `envelope.ts`
- response fields: `other_params.uid`, `other_params.current_status`,
  `data.questionnaire.page_sequence_number`, `data.questionnaire.questions`
  (nests via `questions` + `child_questions`, either may be `false`),
  top-level `breadcrumbs[]` with `state: 'active'`, `application_data_model`
  (`[]` when empty), `answered_groups` — `ApplicationSession.ingest`, `QuestionTree`
- option shape `{id, label[, api_value, product_details]}`; ADM value for an
  option answer is the OBJECT `{id, label[, api_value]}` (a bare id → HTTP 500)
- journey start: load_application → status `products` (one `product_card`)
  → next_page → status `quote` (quote questionnaire page 1) — `selectProduct()`
- next_page body: `{uid, event_type, next_page_flag, page_sequence_number,
  current_breadcrumb_id, application_data_model, answered_groups}` accepted.
  NOTE `page_sequence_number` is always 1 on this version (backend hard-codes it);
  navigation state = breadcrumbs + `other_params.current_status`.
- journey: products → quote (Standard_Quote_DND: Full.Name, Insured.ContactPhoneType,
  Insured.EmailId) → status `questions` (Standard_Application_DND, breadcrumbs
  "Policy Information" → "Remainaing Details" [sic] → "Primary Physician" → "Tobacco Use")
- question_status vocabulary: `missing` (unanswered), `valid`, `invalid` (+
  `question_status_message`, e.g. "Field is required", "Incorrect format or
  length."), `absent` (reflexive condition unmet → engine PRUNES its ADM entry) — `Oracles`
- formats: dates `MM/DD/YYYY`; SSN `NNN-NN-NNNN`; text/number answers are plain strings
- ADM read = GET `api/v4/acquire/application-data-model?uid=`; write = POST
  `/api/application-data-model` `{application_data_model}` — `AcquireApiClient`
**Still assumed — verify on the next pages and fix in one place each:**
- list event field names — `ListBuilder` (first list: beneficiaries, "Remainaing Details"?)
- `page_state_change` body for trigger_api questions — `ApplicationSession.triggerApi`
- currency normalization — `Oracles.admReflects`

## Commands
`npm i && npx playwright install` · `npm run test:dev` (needs `.env`, see
`.env.example`) · `npm run test:harness` · `npm run catalog -- <export.json>`

## Environment safety
Only allowlisted NON-PRODUCTION NAAP URLs in `.env`. Never point at production.
