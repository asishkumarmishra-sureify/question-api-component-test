# Sequence diagrams — how catalog, client, engine and test data work together

Traced from `tests/naap-journey.spec.ts` ("policy information page submits clean and
advances"), `test-data/naap-happy-path.json`, `fixtures/acquire.ts`, `src/catalog/catalog.ts`,
`src/engine/*` and `src/client/*`. Every arrow exists in code. Five small diagrams, one per
concern, rather than one wall. Render with any Mermaid viewer (VS Code Markdown preview).
Diagrams 6 to 14, further down, cover `tests/naap-product-journey.spec.ts`.

## 1. Authoring time — building the catalog (offline, once)

```mermaid
sequenceDiagram
    autonumber
    participant Studio as Studio exports<br/>catalog/exports/*.json
    participant Build as build-catalog.mjs
    participant Cat as naap.questions.json

    Studio->>Build: Standard_Quote_DND + Standard_Application_DND
    Build->>Build: keep sureify_id, label, display_type,<br/>option labels, validations, section,<br/>list-child flag, reflexive condition
    Build->>Cat: 116 entries, no UUID reaches a spec
```

## 2. Fixture setup — hidden from the report (boxed)

```mermaid
sequenceDiagram
    autonumber
    participant Fx as fixtures/acquire.ts
    participant Cat as Catalog
    participant Auth as CognitoAuth
    participant Cog as AWS Cognito
    participant Cli as AcquireApiClient

    Fx->>Cat: new Catalog()  reads naap.questions.json
    Fx->>Auth: new CognitoAuth(.env token url, id, secret, scope)
    Fx->>Cli: new AcquireApiClient(apiStyle, language, auth, onExchange)
    Fx->>Auth: bearer()  warm the token
    Auth->>Cog: POST /oauth2/token (client_credentials, form-encoded)
    Cog-->>Auth: access_token (cached until near expiry)
    Note over Fx,Cli: onExchange = attach request + response JSON<br/>under the current report step, one per API call
    Fx-->>Fx: expose acquire.startApplication()
```

## 3. The journey at page level — what the spec sees

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec<br/>naap-journey.spec.ts
    participant Data as Test data<br/>naap-happy-path.json
    participant Ses as ApplicationSession
    participant Naap as NAAP stg

    Spec->>Ses: startApplication()
    Ses->>Naap: load_application
    Naap-->>Ses: status products (one product_card)

    Spec->>Data: product
    Spec->>Ses: selectProduct("Standard_Quote_DND")
    Ses->>Naap: next_page
    Naap-->>Ses: status quote (Standard_Quote_DND page 1)

    Spec->>Data: quoteContact (3 answers)
    Spec->>Ses: answerPage + continue()
    Ses->>Naap: next_page
    Naap-->>Ses: status questions, breadcrumb "Policy Information"

    Spec->>Data: policyInformation (13 answers)
    Spec->>Ses: answerPage + continue()
    Ses->>Naap: next_page
    Naap-->>Ses: breadcrumb "Remainaing Details"<br/>Basic.Finpro absent and pruned
    Ses-->>Spec: PageAssertions for the new page
```

## 4. One round trip in detail — answerPage() then continue()

This is the loop every page goes through. Response N defines request N+1.

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec<br/>naap-journey.spec.ts
    participant Ses as ApplicationSession
    participant Cat as Catalog
    participant Tree as QuestionTree
    participant Cli as AcquireApiClient
    participant Naap as NAAP stg

    Spec->>Ses: answerPage({ sureify_id: label or text })
    loop each answer
        Ses->>Cat: assertKnown(sureify_id)
        Cat-->>Ses: ok, or throw (typo / stale catalog)
        Ses->>Tree: bySureifyId(sureify_id)
        Tree-->>Ses: live question, or throw (not on this page)
        Ses->>Tree: hasOptions() ? admValueForOption(label)
        Tree-->>Ses: { id, label } object, or the plain string
        Ses->>Ses: adm[sid] = value, pendingAnswers[sid] = value
    end

    Spec->>Ses: continue()
    Ses->>Cli: questions({ uid, next_page, pageSeq,<br/>current_breadcrumb_id, adm, answered_groups })
    Cli->>Cli: Authorization: Bearer (cached token)
    Cli->>Naap: POST /api/questions?language=en-US
    Naap-->>Cli: { code, status, response }
    Cli->>Cli: decodeEnvelope (object or base64)
    Cli->>Cli: onExchange: attach "NN POST … next_page -> 200"
    Cli-->>Ses: QuestionsResponse
    Ses->>Tree: QuestionTree.parse(questions, breadcrumbs)
    Ses->>Ses: ingest(): adm = server echo,<br/>pageSeq, breadcrumbId, status, pendingAnswers = {}
    Ses-->>Spec: PageAssertions(tree, adm, sentOverlay)
```

## 5. Oracles — assertions read state, never the request

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec<br/>naap-journey.spec.ts
    participant Ora as PageAssertions
    participant Tree as QuestionTree
    participant Cat as Catalog
    participant Cli as AcquireApiClient
    participant Naap as NAAP stg

    Spec->>Ora: expectNoErrors()
    Ora->>Tree: allQuestions() with status invalid

    Spec->>Ora: expectEchoConsistent()
    loop each answer just sent
        Ora->>Tree: isAbsent(sid)?  legitimate prune
        Ora->>Cat: get(sid).reflexive?  known conditional
        Ora->>Ora: admReflects(echo[sid], sent[sid])
    end

    Spec->>Ora: expectBreadcrumbTitle(/remain/i)
    Ora->>Tree: activeBreadcrumbTitle()

    Spec->>Ora: expectAdmPersisted()
    Ora->>Cli: getApplicationDataModel(uid)
    Cli->>Naap: GET /api/v4/acquire/application-data-model?uid=
    Naap-->>Cli: persisted ADM
    Cli-->>Ora: decoded ADM (attached to report)
    Ora->>Ora: diff persisted vs session ADM
```

## Reading the diagrams

- **Test data → Catalog → Tree → ADM** (diagram 4) is the resolve-on-write path. A spec
  never carries a UUID: the catalog validates the sureify_id, the live tree turns an option
  label into the `{id, label}` object the engine expects, and the result goes into the ADM.
- **Every response passes through `ingest()`** before anything else happens. The next
  request is built only from `uid`, `pageSeq`, `breadcrumbId`, `answeredGroups` and the
  echoed ADM plus the overlay just answered.
- **The client is the only layer that knows URLs, auth and the envelope.** The fixture's
  `onExchange` hook is why each call shows up as a JSON attachment under its journey step.
- **Oracles read state, not requests** (diagram 5). The sent overlay is used only to know
  which keys to look for in the echo.
- Not shown: `triggerApi()` (page_state_change). No current spec uses it.

---

# Product journey — `tests/naap-product-journey.spec.ts`

Traced from `tests/naap-product-journey.spec.ts`, `test-data/naap-product-journey.json`,
`fixtures/acquire.ts` (`startFromAgentPanel`), `src/engine/ApplicationSession.ts`,
`src/engine/ListBuilder.ts` and `src/client/AcquireApiClient.ts`. Diagrams 2, 4 and 5 above
still apply unchanged: the fixture, the answerPage/continue round trip and the oracles are the
same. The diagrams below cover only what this spec adds.

## 6. The whole journey as server states

`other_params.current_status` after each call. Two sessions take part: the Agent's
(one uid) and the Insured's (a second uid, issued after the identity check).

```mermaid
stateDiagram-v2
    direction LR
    state "quote<br/>Case Setup" as quote
    state "questions<br/>ten application pages" as questions
    state "role_switching<br/>waits for Insured" as waitInsured
    state "challenge<br/>identity check" as challenge
    state "questions<br/>Terms of Use" as terms
    state "signature<br/>signing city and state" as signature
    state "e-signature<br/>documents to sign" as esign
    state "role_switching<br/>waits for Agent Signature" as waitAgent

    [*] --> quote: cutover + open
    quote --> questions: Get Your Quote, continue
    questions --> questions: continue (pages 1 to 9)
    questions --> waitInsured: last continue offers hand-off,<br/>passTo Insured
    waitInsured --> challenge: openNextRoleSession
    challenge --> challenge: wrong zip code
    challenge --> terms: verifyIdentity, uid issued
    terms --> signature: accept terms, continue
    signature --> esign: city and state, continue
    esign --> waitAgent: sign, passTo Agent
    waitAgent --> [*]
```

## 7. Agent-panel start — cutover, then open by uid

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec<br/>naap-product-journey.spec.ts
    participant Data as Test data<br/>agent block
    participant Fx as fixtures/acquire.ts
    participant Ses as ApplicationSession
    participant Cli as AcquireApiClient
    participant Naap as NAAP

    Spec->>Data: agent (name, email, address, agentNumber, clubCode)
    Spec->>Fx: acquire.startFromAgentPanel(agent)
    Fx->>Ses: startFromAgentPanel(agent, { agentId from .env })
    Ses->>Cli: cutover(agent, ctx)
    Cli->>Naap: POST /api/v3/photon/cutover<br/>headers agent_id, user_role Agent<br/>body { payload: agent }
    Naap-->>Cli: { data: { url: eApp host/?uid=... } }
    Cli-->>Ses: uid (read from the launch url)
    Ses->>Cli: questions({ uid, ipAddress, current_breadcrumb_id })
    Note over Ses,Cli: no event_type: this is the page-load call
    Cli->>Naap: POST /api/questions
    Naap-->>Cli: status quote, breadcrumb "Case Setup",<br/>ADM already holds Agent.FullName, Agent.AgentNumber
    Cli-->>Ses: QuestionsResponse
    Ses->>Ses: ingest()
    Ses-->>Spec: session on the quote page
```

## 8. Get Your Quote — a button that calls an API

`callButtonApi('CalculateButton')` reads everything from the live button question. Nothing is
submitted to the question API here: the result rides along on the next `continue()`.

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec
    participant Ses as ApplicationSession
    participant Tree as QuestionTree
    participant Cli as AcquireApiClient
    participant Naap as NAAP

    Spec->>Ses: answerPage(data.quote)  12 answers
    Spec->>Ses: callButtonApi("CalculateButton")
    Ses->>Tree: bySureifyId("CalculateButton")
    Tree-->>Ses: button with api_config, payload_questions_list,<br/>response_config
    loop each payload question
        Ses->>Tree: byQuestionUuid(question_id)
        Ses->>Ses: params[api_param_name] = ADM answer<br/>(label for options, number for amounts)
    end
    Ses->>Cli: custom({ uid, requestUrl, requestMethod, params })
    Cli->>Naap: POST /api/custom  (quote/spark-quote)
    Naap-->>Cli: { code, status, response: { success, quote } }
    Cli-->>Ses: result
    Ses->>Ses: adm[CalculateButton] = result,<br/>response_config values copied to their sureify_ids
    Ses-->>Spec: result (modalPremium asserted)

    Spec->>Ses: continue()
    Ses->>Cli: questions({ next_page, adm incl. quote result })
    Cli->>Naap: POST /api/questions
    Naap-->>Ses: status questions, "Proposed Insured Information",<br/>Quote.Response.ModalPremium and PolicyInfoPolicyNumber in ADM
```

## 9. The Agent's ten pages and the hand-off offer

The page order is the key order of `pages` in the test data. Each key is a breadcrumb title.

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec
    participant Data as Test data<br/>pages
    participant Ses as ApplicationSession
    participant Naap as NAAP

    loop each title in pages (10)
        Spec->>Ses: tree.activeBreadcrumbTitle() is title
        Spec->>Data: pages[title]
        Spec->>Ses: answerPage(answers) + continue()
        Ses->>Naap: next_page
        Naap-->>Ses: next breadcrumb active, this one completed
        Spec->>Ses: expectNoErrors, expectEchoConsistent,<br/>expectBreadcrumbTitle(next title)
    end
    Note over Spec,Naap: Insured Information 19, Owner 8, Beneficiary 2 lists,<br/>Existing Insurance 6, Health 14, HIV Consent 0,<br/>Temporary Insurance 1, Secondary Addressee 1,<br/>Premium Payment 2, Agent Supplemental 13

    Naap-->>Ses: after the last page: other_params.role_switch_config
    Ses->>Ses: ingest(): handoff = role_switch_config
    Spec->>Ses: handoff.transition_roles contains "Insured",<br/>notification_page.title is "Pass application to Insured"
    Spec->>Ses: listRows(both beneficiary lists) has 1 row each
    Spec->>Ses: expectAdmPersisted()
```

## 10. List answers — beneficiaries

A list has no events of its own. Its answer is the whole list, stored under the list
question's sureify_id and sent with the page on `continue()`.

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec
    participant Ses as ApplicationSession
    participant LB as ListBuilder
    participant Cat as Catalog
    participant Tree as QuestionTree

    alt whole list from test data
        Spec->>Ses: answerPage({ "BenePrimary.DesignationsGroup": [ row ] })
        Ses->>Tree: bySureifyId(list)  isList
    else one row at a time
        Spec->>Ses: list("BenePrimary.DesignationsGroup")
        Ses-->>Spec: ListBuilder
        Spec->>LB: addRecord(row)
        LB->>Ses: appendListRow(list, row)
        Ses->>Ses: rows = listRows(list) from the ADM
    end
    loop each field in the row
        Ses->>Cat: assertKnown(sureify_id)
        Ses->>Tree: bySureifyId(sureify_id)  the row template on the page
        Ses->>Tree: admValueForOption(label) for choices
        Tree-->>Ses: { id, label } object, or the plain string
    end
    Ses->>Ses: adm[list] = [ ...rows, resolved row ]<br/>pendingAnswers[list] = same
    Note over Spec,Tree: the next continue() submits the list with the page.<br/>A missing field comes back as an error on that row,<br/>for example "row 1: ... required".
```

## 11. Role hand-off — Agent to Insured

The Insured's session is a separate `ApplicationSession`. Until the identity check passes it
has no uid and is addressed by the `euid` from the launch link.

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec
    participant Agent as Agent session<br/>uid A
    participant Ins as Insured session<br/>euid, then uid B
    participant Cli as AcquireApiClient
    participant Naap as NAAP

    Spec->>Agent: passTo("Insured")
    Agent->>Agent: find "Insured" in handoff.transition_roles, take its uuid
    Agent->>Cli: questions({ uid A, role_transition, user_role_uuid, adm })
    Cli->>Naap: POST /api/questions
    Naap-->>Agent: status role_switching,<br/>notice "It can be accessed only by Insured"

    Spec->>Agent: openNextRoleSession()
    Agent->>Cli: currentAssigneeEuid(uid A)
    Cli->>Naap: GET /api/v4/acquire/app-sessions/current-assignee?uid=A
    Naap-->>Cli: launch link .../?euid=...
    Note over Cli: the euid is a session credential,<br/>it is masked in the report attachment
    Agent->>Ins: new ApplicationSession, euid set
    Ins->>Cli: questions({ ipAddress, current_breadcrumb_id }, { euid })
    Cli->>Naap: POST /api/questions?euid=...
    Naap-->>Ins: status challenge (date of birth + zip code)

    Spec->>Ins: verifyIdentity(wrongIdentityCheck)
    Ins->>Cli: questions({ challenge_submit, adm: answers }, { euid })
    Naap-->>Ins: status challenge,<br/>credential_mismatch_error_message
    Spec->>Ins: identityError matches "does not match our records"

    Spec->>Ins: verifyIdentity(identityCheck)
    Ins->>Cli: questions({ challenge_submit, adm: answers }, { euid })
    Naap-->>Ins: other_params.uid = B, current_role Insured,<br/>Terms of Use page, ADM with the Agent's answers
    Ins->>Ins: ingest(), uid = B, euid cleared
    Spec->>Ins: role is Insured, uid B differs from uid A,<br/>Insured.SSN equals what the Agent entered
```

## 12. Insured stage — terms, signature page, e-signature

```mermaid
sequenceDiagram
    autonumber
    participant Spec as Spec
    participant Data as Test data<br/>insured block
    participant Ins as Insured session
    participant Naap as NAAP

    Spec->>Data: termsOfUse
    Spec->>Ins: answerPage + continue()
    Ins->>Naap: next_page
    Naap-->>Ins: status signature,<br/>InsuredSignatureSigningCity and SigningState visible

    Spec->>Data: signaturePage (Sacramento, California)
    Spec->>Ins: answerPage + continue()
    Ins->>Naap: next_page
    Naap-->>Ins: status e-signature, data = signing request<br/>(feature, payload, payload_hash, signatory_group,<br/>applicable_forms)
    Ins->>Ins: ingest(): esign = data
    Spec->>Ins: esign.signatory_group is Insured,<br/>applicable_forms not empty

    Spec->>Ins: sign()  see diagram 13
    Ins-->>Spec: unsignedDocuments, signedDocuments
    Spec->>Ins: same count, each starts with %PDF,<br/>signatureInfo.envelopeSigned is true,<br/>handoff offers "Agent"

    Spec->>Ins: passTo("Agent")
    Ins->>Naap: role_transition
    Naap-->>Ins: status role_switching, notice "Agent Signature"
```

## 13. sign() in detail — question API and signing service

Every value in a request comes from the response before it. Document generation is a queued
job; if the result stream stays silent the same request is queued again, up to three times.

```mermaid
sequenceDiagram
    autonumber
    participant Ins as Insured session
    participant Cli as AcquireApiClient
    participant Sig as Signing service<br/>/clientId/api/v5/concordia
    participant Naap as NAAP question API

    Note over Ins: esign = { feature, payload, payload_hash,<br/>signatory_group } from the e-signature response
    loop up to 3 attempts
        Ins->>Cli: esignStart({ feature, payload, payloadHash, signatory })
        Cli->>Sig: POST /esignatures/{feature}
        Sig-->>Cli: job_key
        Ins->>Cli: esignAwaitEnvelope(job_key)
        Cli->>Sig: GET /esignature-jobs/listen  (event stream, 75s)
        alt envelope arrives
            Sig-->>Cli: envelope_id, signing_id, documents (unsigned PDFs)
        else stream silent
            Cli-->>Ins: EsignJobTimeout, queue again
        end
    end
    Ins->>Cli: custom({ requestUrl: "esignature", signingId, envelopId, userRole })
    Cli->>Naap: POST /api/custom
    Naap-->>Cli: signature_info.esign_input, sign_status_payload_hash
    Ins->>Cli: esignSign({ feature, envelopeId, signingId, input, payloadHash })
    Cli->>Sig: POST /esignatures/{feature}/sign-status<br/>header x-payload-signature
    Sig-->>Cli: sign_status, documents (signed PDFs)
    Ins->>Cli: questions({ uid, envelope_id, signing_id,<br/>signatory_type, event: signing_complete })
    Cli->>Naap: POST /api/questions
    Naap-->>Ins: signature_info.envelopeSigned true,<br/>role_switch_config offering "Agent"
    Ins->>Ins: ingest()
```

## 14. Which test travels how far

The spine is the journey. Each test box points at the place where that test makes its
assertions. The four rejection tests assert that the page did not advance.

```mermaid
flowchart TD
    A[cutover + open<br/>quote, Case Setup] --> B[Get Your Quote + continue]
    B --> C[Proposed Insured Information]
    C --> D[Proposed Owner Information]
    D --> E[Beneficiary Information]
    E --> F[seven more pages]
    F --> G[passTo Insured<br/>role_switching]
    G --> H[identity check]
    H --> I[Terms of Use]
    I --> J[signature page]
    J --> K[e-signature + sign]
    K --> L[passTo Agent<br/>role_switching]

    T1([agent-panel start opens the quote page]) -.-> A
    T2([Get Your Quote returns a premium]) -.-> C
    T5([cell phone not fully formatted]) -.-> C
    T6([employed without an occupation]) -.-> C
    T8([insured as owner needs name and address]) -.-> D
    T7([primary beneficiary without a last name]) -.-> E
    T3([Agent completes every page and passes on]) -.-> G
    T4([Insured verifies, accepts, signs, passes back]) -.-> L
```

## Reading the product-journey diagrams

- **Two entry points, one loop.** `startFromAgentPanel()` replaces `start()` + `selectProduct()`
  (diagram 7). After that the same answerPage/continue loop from diagram 4 runs every page.
- **A role switch is two things.** `passTo()` is one `role_transition` call on the current
  session. The next role then works in a session of its own (diagram 11): new uid, same
  application data.
- **The hand-off needs no mailbox.** The launch link the email would carry is read from
  `app-sessions/current-assignee`.
- **Signing leaves the question API and comes back** (diagram 13). The signing service
  generates and signs the PDFs; the question API only registers the envelope and is told
  when signing is complete.
- **Test data drives the order.** The keys of `pages` are the breadcrumb titles in journey
  order, so adding or reordering a page is a test-data change, not a spec change.
