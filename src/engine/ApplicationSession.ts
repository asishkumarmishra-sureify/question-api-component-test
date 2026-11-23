import { EsignJobTimeout, type AcquireApiClient } from '../client/AcquireApiClient';
import type { Adm, QuestionsResponse, RoleHandoff } from '../types';
import { QuestionTree, type TreeQuestion } from './QuestionTree';
import { Catalog } from '../catalog/catalog';
import { PageAssertions } from './Oracles';
import { ListBuilder } from './ListBuilder';
import { listIds, noStep, type StepFn } from './Steps';

/**
 * THE ONE INVARIANT:
 *   Every outgoing request is built ONLY from state produced by ingest()
 *   over the immediately preceding response. No cached fixtures, no
 *   remembered UUIDs, no state accumulated outside the loop.
 */
/** One row of a list question (a beneficiary, an existing policy, …): answers by sureify_id. */
export type ListRow = Record<string, string | string[]>;
/** A test-data answer: plain text, an option label, a list of option labels
 *  (multi-select), or a list of rows (list question). */
export type AnswerValue = string | string[] | ListRow[];

export class ApplicationSession {
  uid!: string;
  tree!: QuestionTree;
  adm: Adm = {};                    // ALWAYS the server's last echo + local overlays
  answeredGroups: string[] = [];
  pageSeq = 1;
  breadcrumbId = '';
  /** other_params.current_status from the last response (e.g. 'products', 'quote'). */
  status = '';
  /**
   * Role hand-off offered by the last response (other_params.role_switch_config),
   * or undefined. It appears when the current role has finished its stage and
   * the application must be passed on (e.g. Agent -> Insured for signing).
   */
  handoff?: RoleHandoff;
  /** Role the server says this session acts as (other_params.current_role.name). */
  role = '';
  /** Signing request from the last response when status is 'e-signature', else undefined. */
  esign?: NonNullable<QuestionsResponse['data']>;
  /** State of the signature as last reported by the server. */
  signatureInfo?: QuestionsResponse['signature_info'];
  /** Set while a handed-off session is still behind its identity check; it
   *  addresses the session until the check passes and a uid is issued. */
  private euid?: string;
  private pendingAnswers: Adm = {};

  /** Report-step hook (Playwright: test.step). Defaults to a passthrough. */
  readonly step: StepFn;

  constructor(public client: AcquireApiClient, public catalog: Catalog, opts: { step?: StepFn } = {}) {
    this.step = opts.step ?? noStep;
  }

  /** "Policy Information (questions)" — where the journey is right now, for step titles. */
  private here() {
    const crumb = this.tree?.activeBreadcrumbTitle();
    if (crumb) return `"${crumb}"${this.status ? ` (${this.status})` : ''}`;
    return this.status ? `${this.status} page` : 'page';
  }


  // ---- (1) session start: the only request without a prior response ----
  async start(opts: { product?: string; locale?: string } & Record<string, unknown> = {}) {
    await this.step('Start application (load_application)', async () => {
      const resp = await this.client.questions({ event_type: 'load_application', ...opts });
      // uid is read from other_params, with a top-level fallback for older layouts.
      const uid = resp.other_params?.uid ?? resp.uid;
      if (!uid) throw new Error('load_application returned no uid — check endpoint style/auth');
      this.uid = uid;
      this.ingest(resp);
      await this.step(`→ ${this.here()}`, () => {});
    });
    return this;
  }

  /**
   * Agent-panel start ("Initiate > Begin Quote"): cutover creates the
   * application for the agent, then the eApp opens it by uid. The first page
   * is the product's QUOTE questionnaire (status 'quote', breadcrumb
   * "Case Setup") with the agent's details already in the ADM.
   */
  async startFromAgentPanel(agent: Record<string, unknown>, ctx: { agentId?: string; userRole?: string } = {}) {
    await this.step('Start application from the agent panel (cutover)', async () => {
      this.uid = await this.client.cutover(agent, ctx);
      await this.open();
    });
    return this;
  }

  /** (Re)open the application by uid — the eApp's page-load call. */
  async open() {
    return this.step('Open application (page load)', async () => {
      const resp = await this.client.questions({ uid: this.uid, ipAddress: '', current_breadcrumb_id: this.breadcrumbId });
      this.ingest(resp);
      await this.step(`→ ${this.here()}`, () => {});
      return new PageAssertions(this.tree, this.adm, {}, this.client, this.uid, this.catalog, this.step);
    });
  }

  // ---- (2) ingest: runs after EVERY response, no exceptions ----
  ingest(resp: QuestionsResponse) {
    this.tree = QuestionTree.parse(resp.data?.questionnaire?.questions, resp.breadcrumbs ?? []);
    if (resp.application_data_model !== undefined) {
      // server echo wins. An empty ADM arrives as [] — normalize to {}.
      const echo = resp.application_data_model;
      this.adm = Array.isArray(echo) ? {} : { ...echo };
    }
    // page_sequence_number is read from data.questionnaire, with other_params as fallback.
    this.pageSeq = resp.data?.questionnaire?.page_sequence_number
      ?? resp.other_params?.page_sequence_number
      ?? this.pageSeq;
    this.answeredGroups = resp.answered_groups ?? this.answeredGroups;
    this.breadcrumbId = this.tree.activeBreadcrumbId() ?? this.breadcrumbId;
    this.status = resp.other_params?.current_status ?? this.status;
    this.handoff = resp.other_params?.role_switch_config;
    this.role = resp.other_params?.current_role?.name ?? this.role;
    this.esign = this.status === 'e-signature' ? resp.data : undefined;
    this.signatureInfo = resp.signature_info ?? this.signatureInfo;
    this.pendingAnswers = {};
  }

  // ---- (3) answers: resolve-on-write against the LIVE tree ----
  async answer(sureifyId: string, value: AnswerValue) {
    await this.step(`Answer ${sureifyId}`, () => {
      this.catalog.assertKnown(sureifyId);
      this.answerUncatalogued(sureifyId, value);
    });
  }

  /** Same resolve-on-write, without the catalog guard. Used only for
   *  navigation-type questions that are not part of an authored questionnaire
   *  (e.g. the product picker served by the quote shell). */
  private answerUncatalogued(sureifyId: string, value: AnswerValue) {
    const question = this.tree.bySureifyId(sureifyId);
    if (!question) throw new Error(
      `"${sureifyId}" is not in the current question tree (pageSeq ${this.pageSeq}, ` +
      `breadcrumb ${this.breadcrumbId || '?'}). Reflexive logic may not have revealed it.`);
    const resolved = question.isList ? asRows(sureifyId, value).map(row => this.resolveRow(row)) : this.resolveValue(question, value);
    this.pendingAnswers[sureifyId] = resolved;
    this.adm[sureifyId] = resolved;
  }

  /** Choice questions: label -> live option object; multi-selects take a list of labels. */
  private resolveValue(question: TreeQuestion, value: AnswerValue): unknown {
    if (!question.hasOptions()) return value;
    if (question.isMultiSelect) return (Array.isArray(value) ? value : [value]).map(l => question.admValueForOption(String(l)));
    return question.admValueForOption(String(value));
  }

  /**
   * A list question's answer is the whole list: an array of rows, each row an
   * object keyed by the sureify_ids of the list's row questions. The row
   * questions are served once on the page (as a template), so each row value is
   * resolved against that live node exactly like a normal answer.
   */
  private resolveRow(row: ListRow): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sid, v] of Object.entries(row)) {
      this.catalog.assertKnown(sid);
      const question = this.tree.bySureifyId(sid);
      if (!question) throw new Error(`List row question "${sid}" is not in the current question tree (${this.here()}).`);
      out[sid] = this.resolveValue(question, v);
    }
    return out;
  }

  /** Rows already answered for a list question on this page (from the ADM), as sent. */
  listRows(sureifyId: string): Record<string, unknown>[] {
    const v = this.adm[sureifyId];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }

  /** Append one resolved row to a list question's answer. Used by ListBuilder. */
  appendListRow(listSureifyId: string, row: ListRow) {
    this.catalog.assertKnown(listSureifyId);
    const question = this.tree.bySureifyId(listSureifyId);
    if (!question?.isList) throw new Error(`"${listSureifyId}" is not a list question on the current page (${this.here()}).`);
    const rows = [...this.listRows(listSureifyId), this.resolveRow(row)];
    this.pendingAnswers[listSureifyId] = rows;
    this.adm[listSureifyId] = rows;
  }

  async answerPage(answers: Record<string, AnswerValue>) {
    const ids = Object.keys(answers);
    await this.step(`Answer ${ids.length} question(s) on ${this.here()}: ${listIds(ids)}`, () => {
      for (const [sid, v] of Object.entries(answers)) {
        this.catalog.assertKnown(sid);
        this.answerUncatalogued(sid, v);
      }
    });
  }

  /**
   * Product selection. A fresh application opens with status 'products' on a
   * page whose only question is a `product_card`; its
   * options are the available products (label = product name). Submitting it
   * via next_page moves the application to status 'quote' and serves page 1
   * of that product's QUOTE questionnaire. This page belongs to no authored
   * questionnaire, so it bypasses the catalog — harmless, because the question
   * is located by display_type on the LIVE tree, never by id.
   * Omit `productLabel` to pick the only product when exactly one is offered.
   */
  async selectProduct(productLabel?: string) {
    return this.step(`Select product${productLabel ? ` "${productLabel}"` : ''}`, async () => {
      const cards = this.tree.byDisplayType('product_card');
      if (cards.length !== 1) throw new Error(
        `Expected exactly one product_card question on the current page, found ${cards.length} ` +
        `(status ${this.status || '?'}, pageSeq ${this.pageSeq}).`);
      const card = cards[0];
      const labels = (card.raw.response_options ?? []).map(o => o.label);
      const label = productLabel ?? (labels.length === 1 ? labels[0] : undefined);
      if (!label) throw new Error(`Several products offered, pick one: ${labels.join(' | ')}`);
      if (!card.sureifyId) throw new Error('product_card question has no sureify_id');
      this.answerUncatalogued(card.sureifyId, label);
      return this.continue();
    });
  }

  /** Catalog-driven minimum-valid fill for the current page's visible, unanswered questions. */
  async completePageWithDefaults() {
    await this.step(`Fill remaining visible questions on ${this.here()} with catalog defaults`, () => {
      for (const question of this.tree.allQuestions()) {
        const sid = question.sureifyId;
        if (!sid || question.isHidden || this.adm[sid] != null) continue;
        const dflt = this.catalog.defaultValueFor(sid);
        if (dflt !== undefined) { this.catalog.assertKnown(sid); this.answerUncatalogued(sid, dflt); }
      }
    });
  }

  // ---- (4) continue: serialize ingested state + overlay; close the loop ----
  async continue() {
    return this.step(`Continue from ${this.here()} (next_page)`, async () => {
      const sent = { ...this.pendingAnswers };
      const resp = await this.client.questions({
        uid: this.uid,
        event_type: 'next_page',
        next_page_flag: 1,
        page_sequence_number: this.pageSeq,
        current_breadcrumb_id: this.breadcrumbId,
        application_data_model: this.adm,
        answered_groups: this.answeredGroups,
      });
      this.ingest(resp);
      await this.step(`→ ${this.here()}`, () => {});
      return new PageAssertions(this.tree, this.adm, sent, this.client, this.uid, this.catalog, this.step);
    });
  }

  /**
   * Call the API configured on a button question (e.g. the quote page's
   * "Get Your Quote" -> quote/spark-quote). Everything comes from the LIVE button node:
   *   - `properties.button_config.api_config`  -> which API to call
   *   - `properties.payload_questions_list`    -> which answers to send, under which param names
   *   - `properties.response_config`           -> which response values to copy into which sureify_ids
   * The API's `{ code, status, response }` envelope becomes the button's own
   * answer. Nothing is submitted here: the results ride along with the page's
   * other answers on the next continue().
   */
  async callButtonApi(sureifyId: string) {
    return this.step(`Call the API configured on ${sureifyId} (custom)`, async () => {
      this.catalog.assertKnown(sureifyId);
      const button = this.tree.bySureifyId(sureifyId);
      if (!button) throw new Error(`Button "${sureifyId}" is not in the current question tree (${this.here()}).`);
      const props = (button.raw.properties ?? {}) as any;
      const api = props.button_config?.api_config;
      if (!api?.request_url) throw new Error(`"${sureifyId}" has no api_config.request_url — not an API button.`);

      const params: Record<string, unknown> = { uid: this.uid };
      for (const p of props.payload_questions_list ?? []) {
        if (!p.api_param_name) continue;
        const question = this.tree.byQuestionUuid(p.question_id);
        const value = question?.sureifyId ? apiParamValue(this.adm[question.sureifyId], question.displayType) : undefined;
        if (value !== undefined) params[p.api_param_name] = value;
      }
      const result = await this.client.custom({
        uid: this.uid, requestUrl: api.request_url, requestMethod: api.method ?? 'post',
        headers: api.headers ?? { 'Content-Type': 'application/json' }, params,
      });

      const overlay: Adm = { [sureifyId]: result };
      for (const m of props.response_config ?? []) {
        const v = String(m.value_path ?? '').split('.').reduce((o: any, k: string) => o?.[k], result as any);
        if (v !== undefined) for (const sid of m.sureify_ids ?? []) overlay[sid] = v;
      }
      Object.assign(this.pendingAnswers, overlay);
      Object.assign(this.adm, overlay);
      return result;
    });
  }

  /**
   * Accept the hand-off the server offered after the current role's last page
   * (see `handoff`): pass the application to the named role. The role is
   * looked up in the offer by name. The application then waits for that role
   * (status 'role_switching'); the server notifies them by email.
   */
  async passTo(roleName: string) {
    return this.step(`Pass application to ${roleName} (role_transition)`, async () => {
      const offered = this.handoff?.transition_roles ?? [];
      const role = offered.find(r => r.name === roleName);
      if (!role?.uuid) throw new Error(
        `No hand-off to "${roleName}" is offered on ${this.here()}. Offered: ${offered.map(r => r.name).join(' | ') || '(none)'}`);
      const resp = await this.client.questions({
        uid: this.uid,
        event_type: 'role_transition',
        next_page_flag: 1,
        page_sequence_number: this.pageSeq,
        user_role_uuid: role.uuid,
        application_data_model: this.adm,
        answered_groups: this.answeredGroups,
      });
      this.ingest(resp);
      await this.step(`→ ${this.here()}`, () => {});
      return new PageAssertions(this.tree, this.adm, {}, this.client, this.uid, this.catalog, this.step);
    });
  }

  /**
   * Open the session of the role this application was just passed to, without
   * the hand-off email: the server gives out the same launch link through the
   * API. The returned session is a SEPARATE conversation with its own uid, and
   * starts behind an identity check (status 'challenge'); see verifyIdentity().
   */
  async openNextRoleSession() {
    return this.step('Open the next role\'s session (launch link from the API)', async () => {
      const next = new ApplicationSession(this.client, this.catalog, { step: this.step });
      next.euid = await this.client.currentAssigneeEuid(this.uid);
      const resp = await this.client.questions({ ipAddress: '', current_breadcrumb_id: '' }, { euid: next.euid });
      next.ingest(resp);
      await this.step(`→ ${next.here()}`, () => {});
      return next;
    });
  }

  /**
   * Answer the identity check of a handed-off session (e.g. date of birth and
   * zip code). On success the server issues this session's uid and serves the
   * role's first page; on a mismatch the status stays 'challenge' and
   * `identityError` carries the server's message. The check's questions belong
   * to no authored questionnaire, so they bypass the catalog (like the product picker).
   */
  async verifyIdentity(answers: Record<string, string>) {
    return this.step(`Verify identity: ${listIds(Object.keys(answers))} (challenge_submit)`, async () => {
      if (!this.euid) throw new Error('verifyIdentity() applies to a session opened with openNextRoleSession().');
      for (const [sid, v] of Object.entries(answers)) this.answerUncatalogued(sid, v);
      const resp = await this.client.questions(
        { event_type: 'challenge_submit', application_data_model: this.pendingAnswers, ipAddress: '' }, { euid: this.euid });
      this.identityError = String(resp.other_params?.credential_mismatch_error_message ?? '');
      const uid = resp.other_params?.uid;
      this.ingest(resp);
      if (uid) { this.uid = uid; this.euid = undefined; }
      await this.step(`→ ${this.here()}${this.role ? ` as ${this.role}` : ''}`, () => {});
      return new PageAssertions(this.tree, this.adm, {}, this.client, this.uid, this.catalog, this.step);
    });
  }
  /** The server's message when the last identity check did not match; '' otherwise. */
  identityError = '';

  /**
   * Sign the documents (click-to-sign). Requires status 'e-signature', which
   * the signature page's continue() returns together with the signing request.
   * Sequence, every value taken from the preceding response:
   *   1. signing service: queue document generation with the request payload
   *   2. signing service: wait for the envelope (the filled PDFs)
   *   3. question API (`esignature`): register the envelope, get the signature input
   *   4. signing service: apply the signature
   *   5. question API: `signing_complete` — the reply is ingested like any other
   * Returns the unsigned and signed documents (base64 PDFs) for assertions.
   */
  async sign() {
    return this.step(`Sign the documents as ${this.role || 'current role'}`, async () => {
      const req = this.esign;
      if (!req?.feature || !req.payload || !req.payload_hash) throw new Error(
        `Nothing to sign: status is "${this.status}", expected "e-signature" with a signing request.`);
      const signatory = String(req.signatory_group ?? this.role);
      // Document generation is a queued job whose result arrives on a stream.
      // Now and then the stream stays silent; queueing the same request again recovers.
      let ready: any;
      for (let attempt = 1; ; attempt++) {
        const job = await this.client.esignStart({ feature: req.feature, payload: req.payload, payloadHash: req.payload_hash, signatory, traceId: this.uid });
        try { ready = await this.client.esignAwaitEnvelope(job, this.uid); break; }
        catch (e) { if (!(e instanceof EsignJobTimeout) || attempt === 3) throw e; }
      }
      const envelopeId: string = ready.envelope.envelope_id;
      const signingId: string = ready.signing_id ?? req.signing_id;
      const registered = await this.client.custom({
        uid: this.uid, requestUrl: 'esignature', requestMethod: 'post', enableRetry: true, headers: {},
        params: { signingId, envelopId: envelopeId, uid: this.uid, userRole: signatory },
      });
      const signed = await this.client.esignSign({
        feature: req.feature, envelopeId, signingId, uid: this.uid,
        input: registered.response?.signature_info?.esign_input, payloadHash: registered.response?.sign_status_payload_hash,
      });
      const resp = await this.client.questions({
        uid: this.uid, next_page_flag: 1, envelope_id: envelopeId, signing_id: signingId,
        signatory_type: ready.type ?? 'clicksign', event: 'signing_complete',
      });
      this.ingest(resp);
      await this.step(`→ ${this.here()}`, () => {});
      return {
        unsignedDocuments: (ready.envelope.documents ?? []) as { document_id: string; data: string }[],
        signedDocuments: (signed.documents ?? []) as { document_id: string; data: string }[],
      };
    });
  }

  // ---- (5) lists ----
  list(parentSureifyId: string) {
    return new ListBuilder(this, parentSureifyId);
  }

  /** Deliberate page_state_change for trigger_api questions — mirrors the
   *  frontend's explicit patch (handleThirdPartyCall). */
  async triggerApi(sureifyId: string, value: string) {
    return this.step(`Answer ${sureifyId} and trigger its API (page_state_change)`, async () => {
      this.catalog.assertKnown(sureifyId);
      this.answerUncatalogued(sureifyId, value);
      const question = this.tree.bySureifyId(sureifyId)!;
      const sent = { [sureifyId]: this.adm[sureifyId] };
      const resp = await this.client.questions({
        uid: this.uid,
        event_type: 'page_state_change',
        question_id: question.questionUuid,
        sureify_id: sureifyId,
        application_data_model: this.adm,
      });
      this.ingest(resp);
      return new PageAssertions(this.tree, this.adm, sent as Adm, this.client, this.uid, this.catalog, this.step);
    });
  }
}

function asRows(sureifyId: string, value: AnswerValue): ListRow[] {
  if (Array.isArray(value) && value.every(r => r && typeof r === 'object')) return value as ListRow[];
  throw new Error(`"${sureifyId}" is a list question: its answer must be a list of rows ({ sureify_id: answer }).`);
}

/** ADM answer -> API param for a button call: option answers go by label,
 *  multi-selects as a list of labels, numbers as numbers ("660,900.00" -> 660900). */
function apiParamValue(v: unknown, displayType: string): unknown {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.length ? v.map(x => (x as any)?.label ?? x) : undefined;
  if (typeof v === 'object') return (v as any).label;
  if (displayType === 'number') { const n = Number(String(v).replace(/[$,]/g, '')); return Number.isNaN(n) ? v : n; }
  return v;
}
