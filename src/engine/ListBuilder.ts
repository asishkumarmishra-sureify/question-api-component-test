import type { ApplicationSession, ListRow } from './ApplicationSession';

/**
 * List questions (display_type `beneficiary_list` / `list`).
 *
 * A list has no events of its own. Its answer is the whole list, stored in the
 * ADM under the list question's sureify_id as an array of rows; each row is an
 * object keyed by the sureify_ids of the list's row questions, e.g.
 *   "BenePrimary.DesignationsGroup": [
 *     { "BenePrimary.FirstName": "…", "BenePrimary.RelationshipToProposedInsured": { id, label },
 *       "BenePrimary.AllocationSlider": "100" } ]
 * The rows are submitted with the page's other answers on the next continue().
 * The row questions are served once on the page as a template, so labels are
 * resolved against the live tree like any other answer.
 */
export class ListBuilder {
  constructor(private s: ApplicationSession, private listSid: string) {}

  /** Append one row; answers by sureify_id, option labels for choices. */
  async addRecord(answers: ListRow) {
    await this.s.step(`Add a row to ${this.listSid}`, () => this.s.appendListRow(this.listSid, answers));
    return this;
  }

  /** Rows currently answered for this list. */
  records() { return this.s.listRows(this.listSid); }
}
