import { expect } from '@playwright/test';
import type { AcquireApiClient } from '../client/AcquireApiClient';
import type { Adm } from '../types';
import type { QuestionTree, TreeQuestion } from './QuestionTree';
import type { Catalog } from '../catalog/catalog';
import { noStep, type StepFn } from './Steps';

/**
 * Three oracle families, three bug classes:
 *   A. TREE    -> did the engine compute the right questionnaire STATE?
 *   B. STATUS  -> did the engine enforce the right RULES?
 *   C. ADM     -> did the engine keep the right DATA? (echo + persistence)
 * Assertions read only ingested server state or a fresh GET — never the request we sent.
   * Every assertion is a named report step.
 */
export class PageAssertions {
  constructor(
    private tree: QuestionTree,
    private sessionAdm: Adm,
    private sentOverlay: Adm,
    private client: AcquireApiClient,
    private uid: string,
    private catalog?: Catalog,
    private step: StepFn = noStep,
  ) {}

  private where() {
    const title = this.tree.activeBreadcrumbTitle();
    return title ? ` on "${title}"` : '';
  }

  // ---- A. tree ----
  async expectQuestions(spec: { visible?: string[]; hidden?: string[]; absent?: string[] }) {
    const parts = [
      spec.visible?.length ? `visible: ${spec.visible.join(', ')}` : '',
      spec.hidden?.length ? `hidden: ${spec.hidden.join(', ')}` : '',
      spec.absent?.length ? `absent: ${spec.absent.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    await this.step(`Expect questions${this.where()} — ${parts}`, () => {
      const errors: string[] = [];
      for (const sid of spec.visible ?? []) {
        const q = this.tree.bySureifyId(sid);
        if (!q) errors.push(`${sid}: expected VISIBLE, but ABSENT from tree`);
        else if (q.isHidden) errors.push(`${sid}: expected VISIBLE, but is_hidden=true (reflexive not triggered?)`);
      }
      for (const sid of spec.hidden ?? []) {
        const q = this.tree.bySureifyId(sid);
        if (!q) errors.push(`${sid}: expected HIDDEN, but ABSENT (removed, not hidden — variant tags?)`);
        else if (!q.isHidden) errors.push(`${sid}: expected HIDDEN, but VISIBLE (reflexive leaked?)`);
      }
      for (const sid of spec.absent ?? []) {
        if (this.tree.bySureifyId(sid)) errors.push(`${sid}: expected ABSENT, but present in tree`);
      }
      expect(errors, `question visibility mismatches (expected none)${errors.length ? ':\n' + errors.join('\n') : ''}`).toEqual([]);
    });
    return this;
  }

  async expectBreadcrumb(breadcrumbId: string) {
    await this.step(`Expect active breadcrumb id ${breadcrumbId}`, () => {
      expect(this.tree.activeBreadcrumbId(), 'active breadcrumb id from server tree').toBe(breadcrumbId);
    });
    return this;
  }
  expectStillOn(breadcrumbId: string) { return this.expectBreadcrumb(breadcrumbId); }

  /** Navigation verdict in business language: the active breadcrumb's title. */
  async expectBreadcrumbTitle(title: string | RegExp) {
    await this.step(`Expect active breadcrumb ${typeof title === 'string' ? `"${title}"` : title}`, () => {
      const actual = this.tree.activeBreadcrumbTitle() ?? '';
      const all = this.tree.allBreadcrumbs().map(b => `${b.title || '(untitled)'}:${b.state}`).join(' | ');
      if (typeof title === 'string') expect(actual, `active breadcrumb is "${actual}" (all: ${all})`).toBe(title);
      else expect(actual, `active breadcrumb is "${actual}" (all: ${all})`).toMatch(title);
    });
    return this;
  }

  // ---- B. statuses ----
  async expectQuestionError(sid: string, message?: RegExp) {
    await this.step(`Expect validation failure on ${sid}${message ? ` matching ${message}` : ''}`, () => {
      const q = this.tree.bySureifyId(sid);
      expect(q, `${sid} is present in the current tree`).toBeTruthy();
      expect(q!.hasError, `${sid} carries a validation failure (status "${q!.status}", message "${q!.statusMessage}")`).toBe(true);
      if (message) expect(q!.statusMessage, `${sid} message matches ${message}`).toMatch(message);
    });
    return this;
  }

  async expectNoErrors() {
    await this.step(`Expect no validation errors${this.where()}`, () => {
      const errored = this.tree.allQuestions()
        .filter(q => q.hasError)
        .map(q => `${q.sureifyId ?? q.questionUuid}: ${q.statusMessage}`);
      expect(errored, `field errors (expected none)${errored.length ? ':\n' + errored.join('\n') : ''}`).toEqual([]);
    });
    return this;
  }

  // ---- C1. echo consistency (cheap, every step) ----
  /**
   * Every answer we sent must come back in the ADM echo — EXCEPT answers the
   * engine legitimately prunes because the question's reflexive condition is
   * unmet (such questions carry status 'absent' and their ADM entry is
   * removed). A pruned answer is reported only when the question
   * is neither marked absent nor known to the catalog as reflexive.
   */
  async expectEchoConsistent() {
    const sent = Object.keys(this.sentOverlay);
    await this.step(`Expect ADM echo to keep the ${sent.length} answer(s) just sent`, () => {
      const pruned = (sid: string) => {
        const q = this.tree.bySureifyId(sid);
        if (q?.isAbsent) return true;
        return !q && !!this.catalog?.get(sid)?.reflexive;   // left the page; was conditional
      };
      const dropped = Object.entries(this.sentOverlay)
        .filter(([sid]) => !(this.sessionAdm[sid] === undefined && pruned(sid)))
        .filter(([sid, val]) => !admReflects(this.sessionAdm[sid], val, this.tree.bySureifyId(sid)))
        .map(([sid, val]) => `${sid}: sent ${JSON.stringify(val)}, echo has ${JSON.stringify(this.sessionAdm[sid])}`);
      expect(dropped, `answers dropped or garbled by the ADM echo (expected none)${dropped.length ? ':\n' + dropped.join('\n') : ''}`).toEqual([]);
    });
    return this;
  }

  // ---- C2. persistence round-trip (journey checkpoints) ----
  async expectAdmPersisted(opts: { ignore?: string[] } = {}) {
    await this.step('Expect persisted ADM (fresh GET) to match the session ADM', async () => {
      const stored = await this.client.getApplicationDataModel(this.uid);
      const diffs: string[] = [];
      for (const [sid, val] of Object.entries(this.sessionAdm)) {
        if (opts.ignore?.includes(sid)) continue;
        if (!admReflects(stored[sid], val, this.tree.bySureifyId(sid)))
          diffs.push(`${sid}: session=${JSON.stringify(val)} persisted=${JSON.stringify(stored[sid])}`);
      }
      expect(diffs, `differences between persisted and session ADM (expected none)${diffs.length ? ':\n' + diffs.join('\n') : ''}`).toEqual([]);
    });
    return this;
  }
}

function isOptionValue(v: unknown): v is { id: string; label?: string } {
  return !!v && typeof v === 'object' && typeof (v as any).id === 'string';
}

/** "660,900.00" / "$250,000" / 250000 -> 250000; NaN when not numeric. */
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, '') || NaN);
}

/** Equality with per-type normalization — extend the switch as new display types are covered. */
function admReflects(echoed: unknown, sent: unknown, q?: TreeQuestion): boolean {
  if (echoed === sent) return true;
  // Option answers travel as { id, label[, api_value] } objects; compare by id.
  if (isOptionValue(sent)) return isOptionValue(echoed) && echoed.id === sent.id;
  // Multi-select answers are lists of option objects; compare the id sets.
  if (Array.isArray(sent) && sent.every(isOptionValue)) {
    if (!Array.isArray(echoed) || !echoed.every(isOptionValue)) return false;
    const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort().join(',');
    return ids(echoed) === ids(sent);
  }
  switch (q?.raw.display_type) {
    case 'datepicker': return String(echoed).replaceAll('/', '-') === String(sent).replaceAll('/', '-');
    case 'currency':
    case 'number': return asNumber(echoed) === asNumber(sent);
  }
  // A button's answer is the `{ code, status, response }` envelope of its API
  // call. The server stores it with every scalar stringified (200 -> "200"),
  // and the button is usually off the page by the time the echo arrives, so
  // this is recognised by shape and compared by presence of a result.
  if (isApiResult(sent)) return isApiResult(echoed);
  // Values copied out of an API result (e.g. Quote.Response.Age) are sent with
  // their JSON type and echoed as strings: 41 comes back as "41".
  return deepReflects(echoed, sent);
}

/**
 * Structural comparison for composite answers (list rows): key order is
 * ignored, option objects are compared by id, scalars as strings. Every key
 * that was sent must come back; extra keys in the echo are allowed.
 */
function deepReflects(echoed: unknown, sent: unknown): boolean {
  if (isScalar(sent)) return isScalar(echoed) && String(echoed) === String(sent);
  if (isOptionValue(sent)) return isOptionValue(echoed) && echoed.id === sent.id;
  if (Array.isArray(sent)) {
    return Array.isArray(echoed) && echoed.length === sent.length && sent.every((v, i) => deepReflects(echoed[i], v));
  }
  if (sent && typeof sent === 'object') {
    if (!echoed || typeof echoed !== 'object') return false;
    return Object.entries(sent).every(([k, v]) => deepReflects((echoed as Record<string, unknown>)[k], v));
  }
  return echoed === sent || (echoed == null && sent == null);
}

function isApiResult(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'code' in v && 'response' in v;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
