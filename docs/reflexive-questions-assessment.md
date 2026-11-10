# Assessment: will the harness handle complex reflexive questions?

## Context
User asked whether the current API harness (`src/engine/*`) copes with complex reflexive
(conditional/follow-up) questions on NAAP. User chose **assessment only, no code changes**, and
approved live runs on NAAP staging for confirmation. Sources: harness code; NAAP Studio exports +
generated catalog; saved live NAAP stg responses (2026-10-09/10); live `variant-tags` and
`pdf-form-fields-configuration` reads (2026-10-11); base engine source read by an Explore agent
(`Product_Acquire/acquire-engine`, current base copy — **newer than the alpha.41 pin NAAP runs**).

## Verdict
**Simple and medium reflexives: yes, by design of the protocol, not by design of the harness.**
**Deep/list reflexives (beneficiary block): not yet — the list protocol in `ListBuilder` is wrong
for this engine, and the harness has no model of conditions, so it cannot author or assert
reveal/prune behaviour.** Nothing is blocked by UUIDs: every condition is resolvable to
"child appears when parent = label" from data we already have.

## What is true about NAAP reflexives (facts)
Structure (catalog built from both exports):
- 116 ids, 67 reflexive, 30 list children (29 reflexive). Chain depth 1: 25, depth 2: 33, depth 3: 9
  (all depth-3 are beneficiary UTMA fields: `Beneficiary.Slider → PrimaryBeneficiary.Type → UTMAStatus → UTMA*`).
- Fan-out parents: `PrimaryBeneficiary.Type` (19), `UTMAStatus` (9), `Notice.Lapsenote` (8), `Physician.Details` (8),
  `Notice.Another` (7), `About.Driverlic` (4), `Basic.Finpro` (3), `Physician.Yes` (2).
- Every condition is one `&&` expression with a single condition. 38 reference a variant tag; 29 (beneficiary
  children) carry the condition inline. Operators seen: `OR [option ids]`, `greaterThanOrEqualTo 50` (slider).
- Live variant-tags (20) resolve all 38 tag conditions; the export resolves the 29 inline ones. Decoded examples:
  `Basic.SUS ⇐ Basic.CountryofResidence = "United States of America"`, `Basic.Finpro ⇐ Basic.State = "Florida"`,
  `About.Lic* ⇐ About.Driverlic = "Yes"`, `PrimaryBeneficiary.FirstName ⇐ PrimaryBeneficiary.Type = naturalPerson`.

Protocol (engine source + live confirmation):
- Pages are **flat**. Reflexive children are served alongside their parents, `is_hidden=false`, status `missing`,
  with `child_questions:false`; each node carries `parent_id` and a `parent_question_answer` JSON string.
  `child_questions` is not used by the Sureify questionnaire at all (only MRAS/Challenge).
- **The server does not reveal/hide on request.** Visibility is decided client-side from `parent_question_answer`.
  `page_state_change` does NOT need `question_id`/flags; it re-validates the page against the sent ADM, runs
  API-event mappings + triggers, **persists the merged ADM and marks the breadcrumb answered**, and returns the same page.
- On `next_page` the engine evaluates each condition independently per node (nested chains work with no cascade),
  marks unmet-condition questions `absent` (not required), met-but-unanswered required ones `invalid`, and
  — on this NAAP deployment — **prunes the unmet child's ADM entry** (live: `Basic.Finpro` dropped for CA and NY).
  The newer base engine does not prune; the deployed alpha.41 does. Treat pruning as version-dependent.
- Lists: **no add/save/delete events or flags exist.** A row is just an element of `ListSureifyId: [ {childSid: value, …}, … ]`
  sent in the ADM; reflexives inside rows are evaluated per row index; row errors arrive in
  `question.error_list_questions[listKey][]{index, question_status_message}`. Nested lists use `NL_<childList>_<n>` keys.

## What the harness does today, measured against that
| Capability | Status | Why |
|---|---|---|
| Nested/deep reflexives on a normal page | Works | `QuestionTree.parse` recurses; pages are flat anyway; server evaluates per node |
| Answering a child before/after its parent | Works | `answer()` only requires presence in tree; order irrelevant on this protocol |
| Unmet child answered by mistake | Tolerated, not detected | Server prunes + `absent`; `expectEchoConsistent` suppresses the drop via `absent`/catalog check — no assertion that the prune was *correct* |
| Asserting "answering X reveals Y" | Not possible | `expectQuestions` checks presence/`is_hidden` only; on NAAP every child is present and `is_hidden=false` → visible/hidden assertions are meaningless; need status-based (`absent` vs `missing/valid/invalid`) oracle + resolved conditions |
| Choosing answers that satisfy a chain | Author's burden | Catalog stores opaque uuids; no helper to compute "what makes Y applicable"; test data was hand-derived from a live probe |
| `completePageWithDefaults` | Over-fills | Fills every non-hidden question, including children whose condition is unmet → relies on server pruning; wrong on engines that don't prune |
| Beneficiary list (`beneficiary_list`, 29 reflexive children, depth 3) | Will not work | `ListBuilder` sends `list_question_id`/`list_item_add_flag`/`list_item_save_flag` (dead legacy params) and never writes the `ListSid: [ {…} ]` array; row errors (`error_list_questions`) are not read |
| Triggers / API-event mappings on `page_state_change` | Partially | `triggerApi()` sends `question_id`+`sureify_id` (harmless); engine runs mappings/triggers on the ADM; failures on page_state_change are silent — oracle can't see them |
| Side effects of `page_state_change` | Unmodelled | It persists ADM and marks the breadcrumb answered; harness treats it as a pure "patch" |

## Risks worth stating
- **Engine version drift**: NAAP pins acquire-engine v1.0.0-alpha.41; the S3 base copy is newer (no pruning,
  conditions with injected `sureify_id`). Any harness logic must key off live response shape, not the base source.
- `is_hidden` is not a visibility signal for reflexives on this engine; status is.
- Variant tag with 7 AND-ed conditions ("If medical details are Yes") exists — fine for the engine, but hand-authoring that path is error-prone without resolved conditions.

## Recommended follow-ups (NOT in scope now — user chose assessment only)
1. Catalog build: resolve `reflexive.condition` to `{parent, operator, labels}` using live variant-tags
   (`GET /api/v4/acquire/variant-tags`) + export option labels; drop the raw uuid blob.
2. Engine: `ApplicationSession` evaluates resolved conditions locally → `answer()` warns/refuses for unmet children;
   `completePageWithDefaults` fills only applicable questions.
3. Oracles: `expectApplicable([...])` / `expectNotApplicable([...])` based on `question_status` (`absent` vs others),
   plus `expectPruned` tied to resolved conditions instead of the current blanket tolerance.
4. `ListBuilder` rewrite: build `ListSid: [rows]` in the ADM, submit via `page_state_change`/`next_page`, read `error_list_questions`.
5. Note in CLAUDE.md that `page_state_change` persists state (not a dry-run).

## Verification (optional live confirmation, approved by user; throwaway probe in scratchpad, no project changes)
1. Drive products → quote → Policy Information with the existing probe, then continue into "Remainaing Details".
2. On a page with a visible reflexive parent (e.g. `About.Driverlic`), submit `No` with `About.Licnum` answered →
   expect `About.Licnum` status `absent` and its ADM key pruned; submit `Yes` without it → expect `invalid`.
3. On the beneficiary page, send `Beneficiary.Slider`/`PrimaryBeneficiary.*` as `ListSid: [ {…} ]` rows via
   `next_page`; confirm row validation surfaces in `error_list_questions` and that a `Type = Trust` row makes
   `UTMA*` absent while `Natural Person` + `UTMAStatus = Yes` makes them required (depth-3 chain).
4. Record the observed shapes in CLAUDE.md "verified" list when follow-ups are picked up.
