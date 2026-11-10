# Sequence diagrams — how catalog, client, engine and test data work together

Traced from `tests/naap-journey.spec.ts` ("policy information page submits clean and
advances"), `test-data/naap-happy-path.json`, `fixtures/acquire.ts`, `src/catalog/catalog.ts`,
`src/engine/*` and `src/client/*`. Every arrow exists in code. Five small diagrams, one per
concern, rather than one wall. Render with any Mermaid viewer (VS Code Markdown preview).

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
- Not shown: `triggerApi()` (page_state_change) and `list()` (ListBuilder). No current spec
  uses them, and the list protocol is known to be wrong for this engine
  (see `reflexive-questions-assessment.md`).
