import type { ApplicationSession } from './ApplicationSession';

/**
 * List flows = the same loop with a smaller orbit. Every event is a full
 * send -> ingest cycle because each response restructures the tree (new
 * record rows, revealed reflexive children with FRESH question UUIDs).
 *
 * TODO(pilot): field names for list events (list_question_id,
 * list_item_add_flag, reflexive_question_flag, list_item_save_flag) match
 * the base-product frontend; verify against NAAP's gnarliest list screen
 * in week 2 and adjust HERE only.
 */
export class ListBuilder {
  constructor(private s: ApplicationSession, private parentSid: string) {}

  private parentUuid() {
    const q = this.s.tree.bySureifyId(this.parentSid);
    if (!q) throw new Error(`List parent "${this.parentSid}" not in current tree`);
    return q.questionUuid;
  }

  async addRecord(answers: Record<string, string>) {
    // 1) open a draft row
    let resp = await this.s.client.questions({
      uid: this.s.uid,
      event_type: 'page_state_change',
      list_question_id: this.parentUuid(),
      list_item_add_flag: 1,
      application_data_model: this.s.adm,
    });
    this.s.ingest(resp);

    // 2) answer the row's questions from the POST-ADD tree (incl. reflexives)
    for (const [sid, v] of Object.entries(answers)) await this.s.answer(sid, v);

    // 3) save the row
    resp = await this.s.client.questions({
      uid: this.s.uid,
      event_type: 'page_state_change',
      list_question_id: this.parentUuid(),
      list_item_save_flag: 1,
      application_data_model: this.s.adm,
    });
    this.s.ingest(resp);
    return this;
  }
}
