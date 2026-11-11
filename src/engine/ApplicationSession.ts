import type { AcquireApiClient } from '../client/AcquireApiClient';
import type { Adm, QuestionsResponse } from '../types';
import { QuestionTree } from './QuestionTree';
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
export class ApplicationSession {
  uid!: string;
  tree!: QuestionTree;
  adm: Adm = {};                    // ALWAYS the server's last echo + local overlays
  answeredGroups: string[] = [];
  pageSeq = 1;
  breadcrumbId = '';
  /** other_params.current_status from the last response (e.g. 'products', 'quote'). */
  status = '';
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
    this.pendingAnswers = {};
  }

  // ---- (3) answers: resolve-on-write against the LIVE tree ----
  async answer(sureifyId: string, value: string) {
    await this.step(`Answer ${sureifyId}`, () => {
      this.catalog.assertKnown(sureifyId);
      this.answerUncatalogued(sureifyId, value);
    });
  }

  /** Same resolve-on-write, without the catalog guard. Used only for
   *  navigation-type questions that are not part of an authored questionnaire
   *  (e.g. the product picker served by the quote shell). */
  private answerUncatalogued(sureifyId: string, value: string) {
    const q = this.tree.bySureifyId(sureifyId);
    if (!q) throw new Error(
      `"${sureifyId}" is not in the current question tree (pageSeq ${this.pageSeq}, ` +
      `breadcrumb ${this.breadcrumbId || '?'}). Reflexive logic may not have revealed it.`);
    const resolved = q.hasOptions() ? q.admValueForOption(value) : value;
    this.pendingAnswers[sureifyId] = resolved;
    this.adm[sureifyId] = resolved;
  }

  async answerPage(answers: Record<string, string>) {
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
      for (const q of this.tree.allQuestions()) {
        const sid = q.sureifyId;
        if (!sid || q.isHidden || this.adm[sid] != null) continue;
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

  // ---- (5) list sub-loop ----
  list(parentSureifyId: string) {
    return new ListBuilder(this, parentSureifyId);
  }

  /** Deliberate page_state_change for trigger_api questions — mirrors the
   *  frontend's explicit patch (handleThirdPartyCall). */
  async triggerApi(sureifyId: string, value: string) {
    return this.step(`Answer ${sureifyId} and trigger its API (page_state_change)`, async () => {
      this.catalog.assertKnown(sureifyId);
      this.answerUncatalogued(sureifyId, value);
      const q = this.tree.bySureifyId(sureifyId)!;
      const sent = { [sureifyId]: this.adm[sureifyId] };
      const resp = await this.client.questions({
        uid: this.uid,
        event_type: 'page_state_change',
        question_id: q.questionUuid,
        sureify_id: sureifyId,
        application_data_model: this.adm,
      });
      this.ingest(resp);
      return new PageAssertions(this.tree, this.adm, sent as Adm, this.client, this.uid, this.catalog, this.step);
    });
  }
}
