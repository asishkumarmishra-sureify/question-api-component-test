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
  generated from the Acquire Studio exports in `catalog/exports/`: the real
  product (NAAP Product Quote v9 + NAAP Product Application v47) and the DND
  sandbox pair (Standard_Quote_DND + Standard_Application_DND). 513 sureify_ids.
  Raw exports live in `catalog/exports/`, never at the catalog path.
  Rebuild everything: `npm run catalog:naap`
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

Verified against live NAAP stg traffic (Acquire v2.5.20, 2026-11-18) — the REAL product:
- two entry points. Bare `load_application` only offers the DND sandbox product.
  The real product starts like the agent panel's "Initiate > Begin Quote":
  POST `/api/v3/photon/cutover` `{payload: <agent details>}` + headers `user_role: Agent`,
  `display_quote_experiences: false` (`agent_id` optional) → `{code, data: {url: "…/?uid=<uid>"}}`
  (NOT the questions envelope), then POST `/api/questions` `{uid, ipAddress, current_breadcrumb_id}`
  with no event_type opens it — `AcquireApiClient.cutover`, `ApplicationSession.startFromAgentPanel`
- `naap.env01.dev.aaalife.com` (the eApp tab) fronts the SAME backend as `aaanaap-stg.sureify.com`,
  but is behind Cloudflare and rejects scripted calls. Tests stay on `aaanaap-stg`.
- journey, role Agent: status `quote` ("Case Setup", NAAP Product Quote) → `questions` with
  breadcrumbs Proposed Insured Information → Proposed Owner Information → Beneficiary Information
  → Existing Insurance → Proposed Insured Health Information → HIV Testing Consent
  → Temporary Insurance Agreement (appears once the insured page is submitted) → Secondary Addressee
  Information → Premium Payment → Agent Supplemental Information → hidden "Proceed with Document Signing"
- API buttons (display_type `button`, e.g. `CalculateButton` "Get Your Quote"): POST `/api/custom`
  `{uid, requestUrl, requestMethod, headers, params}`; `requestUrl` from the node's
  `properties.button_config.api_config`, `params` from `properties.payload_questions_list`
  (question uuid → api_param_name; option answers by label, numbers as numbers). The
  `{code, status, response}` result becomes the button's ADM answer and
  `properties.response_config` copies values into other sureify_ids; all of it rides on the
  next `next_page` — `ApplicationSession.callButtonApi`
- multi-select (checkbox) answers are a LIST of option objects `[{id, label}]`
- free-entry questions can carry stale `response_options` (text `Insured.FirstName` has Yes|No);
  choice vs free entry is decided by display_type — `TreeQuestion.hasOptions`
- phone format `(NNN) NNN-NNNN`
- lists (display_type `beneficiary_list` / `list`) have NO events: the answer is the whole
  list in the ADM under the list's sureify_id, an array of rows keyed by the row questions'
  sureify_ids (`"BenePrimary.DesignationsGroup": [{ "BenePrimary.FirstName": …,
  "BenePrimary.RelationshipToProposedInsured": {id, label}, "BenePrimary.AllocationSlider": "100" }]`),
  submitted on the page's `next_page`. Row questions are served once as a template. A failing
  row marks the ROW QUESTION `invalid` with an empty message and
  `error_list_questions: {<list sid>: [{index, question_status_message}]}` —
  `ApplicationSession.answerPage` / `ListBuilder`, `TreeQuestion.statusMessage`
- end of the Agent's stage: after the last page validates, the SAME breadcrumb stays active and
  `other_params.role_switch_config` appears (`transition_roles: [Insured]`, "Pass application to
  Insured") — `ApplicationSession.handoff`. A page-load (`open()`) response does NOT carry it.
- hand-off: `event_type: role_transition` + `user_role_uuid` (from `transition_roles`) +
  `next_page_flag, page_sequence_number, application_data_model, answered_groups` → status
  `role_switching`, breadcrumb "Role switching", label question `Transition` naming the stage
  and role that now own the application; no ADM echo. The server emails that role —
  `ApplicationSession.passTo`
- next role WITHOUT the email: GET `/api/v4/acquire/app-sessions/current-assignee?uid=<previous
  role's uid>` → `{response: {data: {url: "<eApp>/?euid=<encrypted>"}}}`. POST `/api/questions?euid=…`
  (no uid) → status `challenge` (questions `Insured.DateOfBirth`, `Challenge.ZipCodeLast5Challenge`,
  not in any export). `event_type: challenge_submit` + `application_data_model` of the answers, still
  addressed by `?euid=` → wrong answers: status stays `challenge` and
  `other_params.credential_mismatch_error_message` is set; correct: `current_role` = the new role,
  a NEW `other_params.uid` (a separate session on the same app_id) and the role's first page —
  `AcquireApiClient.currentAssigneeEuid`, `ApplicationSession.openNextRoleSession` / `verifyIdentity`
- Insured stage: status `static` (Terms of Use, `TermsAndConditionsConsent2` multi-select) →
  `signature` (`InsuredSignatureSigningCity/State`) → `next_page` returns `e-signature`: no
  questionnaire, no ADM echo, `data.{feature, payload, payload_hash, signatory_group, signing_id,
  applicable_forms, input_json}` + `signature_info` — `ApplicationSession.esign`
- signing (CLICKSIGN), the service is Concordia at `/<clientId>/api/v5/concordia` (clientId
  `aaanaapstg`) on the SAME host with the SAME bearer:
  1. POST `esignatures/<feature>`, body = `data.payload` as text/plain, headers
     `x-payload-signature: data.payload_hash`, `x-signatory`, `x-lifetime-trace-id: <uid>` → `job_key`
  2. GET `esignature-jobs/listen?job_key=&trace_id=` (server-sent events) → `{type, signing_id,
     envelope: {envelope_id, documents: [{document_id, data: base64 PDF}]}}`. Under parallel load
     the stream has stayed silent for 3 minutes once; `sign()` re-queues after 75 s.
  3. POST `/api/custom` `{requestUrl: "esignature", params: {signingId, envelopId, uid, userRole}}`
     → `signature_info.esign_input` + `sign_status_payload_hash`
  4. POST `esignatures/<feature>/sign-status` `{envelope_id, signing_id, url, input: esign_input,
     sign_status: 1}` + `x-payload-signature: sign_status_payload_hash` → signed documents
  5. POST `/api/questions` `{uid, next_page_flag, envelope_id, signing_id, signatory_type,
     event: "signing_complete"}` (key is `event`, not `event_type`) → status `signature`,
     `signature_info.envelopeSigned: true`, hand-off offer to the Agent
  — `AcquireApiClient.esign*`, `ApplicationSession.sign`. Then `passTo('Agent')` → `role_switching`,
  stage "Agent Signature".
- the server does not copy insured → owner when `Insured.IsPolicyOwner = Yes` (the eApp does it
  in the browser from `/api/prefill-config`); tests answer `Owner.*` explicitly.
- drift: live stg serves questions that are not in the v47 export (seen: `Unemployed.NotWorkingReason`,
  revealed by `Insured.IsEmployed = No`). The catalog guard rejects them until a newer export is added.
- observed, not asserted (possible server-side gaps): `next_page` on Beneficiary Information is
  accepted with NO beneficiary, although `BenePrimary.DesignationsGroup` is marked required, and
  with a single primary beneficiary at 50% allocation.

**Still assumed — verify on the next pages and fix in one place each:**
- the stages after the Insured's signature (Agent signature; Owner/Payor when they differ from the insured)
- card payment on Premium Payment (external payment gateway; tests use Direct Bill)
- existing-insurance and additional-agent lists (same list shape expected, not yet exercised)
- `page_state_change` body for trigger_api questions — `ApplicationSession.triggerApi`
- currency normalization — `Oracles.admReflects`

## Commands
`npm i && npx playwright install` · `npm run test:dev` (needs `.env`, see
`.env.example`) · `npm run test:harness` · `npm run catalog -- <export.json>`

## Environment safety
Only allowlisted NON-PRODUCTION NAAP URLs in `.env`. Never point at production.
