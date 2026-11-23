import type { RawBreadcrumb, RawOption, RawQuestion } from '../types';

const FREE_ENTRY_TYPES = new Set(['text', 'textarea', 'number', 'currency', 'date', 'datepicker', 'label', 'slider', 'button']);

/**
 * One question from the latest API response, with readable accessors over its raw JSON
 * (id, type, validation status). It also turns a human option label into the option
 * object the API expects
 */
export class TreeQuestion {
  constructor(public raw: RawQuestion, public parent?: TreeQuestion) {}
  get sureifyId() { return this.raw.sureify_id; }
  get questionUuid() { return this.raw.question_id; }
  get displayType() { return this.raw.display_type ?? ''; }
  get isHidden() { return this.raw.is_hidden === true; }
  get status() { return this.raw.question_status ?? ''; }
  /** Status vocabulary the oracles rely on: failed validation = 'invalid' (msg e.g.
   *  "Field is required", "Incorrect format or length."); unanswered required = 'missing';
   *  accepted = 'valid'; not applicable (reflexive condition unmet) = 'absent'.
   *  'error' is also treated as a failure for deployments that use it. */
  get hasError() { return this.status === 'invalid' || this.status === 'error'; }
  get isAbsent() { return this.status === 'absent'; }
  /** The question's own message, or — for a row question of a list — the
   *  per-row messages the server reports in `error_list_questions`
   *  ({ <list sureify_id>: [{ index, question_status_message }] }), as "row 1: …". */
  get statusMessage() {
    if (this.raw.question_status_message) return this.raw.question_status_message;
    return Object.values(this.raw.error_list_questions ?? {}).flat()
      .map(e => `row ${e.index + 1}: ${e.question_status_message ?? ''}`).join('; ');
  }
  /** A choice question = it carries options AND is not a free-entry type.
   *  Studio leaves stale `response_options` on some free-entry questions
   *  (e.g. a text field that was once a Yes/No), so options alone prove nothing. */
  hasOptions() {
    return (this.raw.response_options?.length ?? 0) > 0 && !FREE_ENTRY_TYPES.has(this.displayType);
  }
  /** List questions (beneficiaries, existing policies, …): the answer is an array of rows. */
  get isList() { return this.displayType === 'beneficiary_list' || this.displayType === 'list'; }
  get isMultiSelect() { return this.displayType === 'checkbox' || this.raw.question_type === 'multiselection'; }

  /** Label -> live option, resolved from THIS response. Case-insensitive. */
  resolveOptionByLabel(label: string): RawOption {
    const opts = this.raw.response_options ?? [];
    const hit = opts.find(o => o.label?.trim().toLowerCase() === label.trim().toLowerCase());
    if (!hit) {
      throw new Error(
        `Option "${label}" not found on ${this.sureifyId ?? this.questionUuid}. ` +
        `Available: ${opts.map(o => o.label).join(' | ') || '(none)'}`);
    }
    return hit;
  }

  /**
   * ADM value for an option answer. We always send option answers as objects
   * `{ id, label[, api_value] }`, never as a bare id: the engine rejects a
   * bare id on next_page with HTTP 500.
   */
  admValueForOption(label: string): Record<string, unknown> {
    const o = this.resolveOptionByLabel(label);
    return o.api_value !== undefined ? { id: o.id, label: o.label, api_value: o.api_value } : { id: o.id, label: o.label };
  }
}

/**
 * Indexed, flattened view of one response's questionnaire tree.
 * Rebuilt from scratch on every ingest — never mutated, never cached across calls.
 *
 * Nesting handled: breadcrumb → questions_group → leaf via `questions`;
 * reflexive children via `child_questions`. Both may be `false`.
 */
export class QuestionTree {
  private bySid = new Map<string, TreeQuestion>();
  private byUuid = new Map<string, TreeQuestion>();
  private all: TreeQuestion[] = [];
  private breadcrumbs: RawBreadcrumb[] = [];

  static parse(questions: RawQuestion[] | RawQuestion | undefined, breadcrumbs: RawBreadcrumb[] = []): QuestionTree {
    const t = new QuestionTree();
    t.breadcrumbs = breadcrumbs;
    const walk = (qs: RawQuestion[] | RawQuestion | false | undefined, parent?: TreeQuestion) => {
      if (!qs) return;
      for (const raw of Array.isArray(qs) ? qs : [qs]) {
        const node = new TreeQuestion(raw, parent);
        t.all.push(node);
        if (raw.sureify_id) t.bySid.set(raw.sureify_id, node);
        if (raw.question_id) t.byUuid.set(raw.question_id, node);
        walk(raw.questions, node);
        walk(raw.child_questions, node);
      }
    };
    walk(questions);
    return t;
  }

  bySureifyId(sid: string) { return this.bySid.get(sid); }
  byQuestionUuid(uuid: string) { return this.byUuid.get(uuid); }
  byDisplayType(displayType: string) { return this.all.filter(q => q.displayType === displayType); }
  allQuestions() { return this.all; }
  allBreadcrumbs() { return this.breadcrumbs; }

  /**
   * Active breadcrumb = the entry in the response's top-level `breadcrumbs`
   * array whose state is 'active'. Falls back to a
   * breadcrumb-typed question node carrying an active marker, for deployments
   * that mark it inline. Returns undefined when nothing is marked.
   */
  /** Title of the active breadcrumb as the server labels it (top-level breadcrumbs[].title). */
  activeBreadcrumbTitle(): string | undefined {
    return this.breadcrumbs.find(b => b.state === 'active')?.title;
  }

  activeBreadcrumbId(): string | undefined {
    const crumb = this.breadcrumbs.find(b => b.state === 'active');
    if (crumb) return crumb.breadcrumb_id;
    const inline = this.all.filter(q => q.displayType === 'breadcrumb').find(q =>
      q.status === 'active' ||
      (q.raw.properties as any)?.is_active === true ||
      q.raw.response === true);
    return inline?.questionUuid;
  }
}
