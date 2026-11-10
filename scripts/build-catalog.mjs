#!/usr/bin/env node
/**
 * build-catalog.mjs — Studio questionnaire export → test-authoring catalog.
 *
 * Usage:   node scripts/build-catalog.mjs <export.json> [<export.json> ...] [--out out.json]
 *          One journey spans several Studio questionnaires (NAAP: QUOTE then
 *          APPLICATION); pass every export and they are merged into ONE catalog.
 * Output:  catalog keyed by sureify_id. Deliberately EXCLUDES question/option
 *          UUIDs as authoring keys — those are resolved from live responses
 *          at run time. Labels, structure, conditions only.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : 'catalog/naap.questions.json';
const inPaths = argv.filter((a, i) => a !== '--out' && (outIdx < 0 || i !== outIdx + 1));
if (!inPaths.length) { console.error('usage: build-catalog.mjs <export.json> [<export.json> ...] [--out out.json]'); process.exit(1); }

const catalog = {};
const sources = [];
let withOptions = 0, reflexive = 0, sectionCount = 0;

for (const inPath of inPaths) {
const d = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const questionnaire = {
  name: d.product_questionnaire?.name ?? null,
  type: d.product_questionnaire?.type ?? null,
  uuid: d.uuid, version: d.version, title: d.title,
};
sources.push({ file: inPath.split('/').pop(), ...questionnaire });
const sections = new Map((d.application_sections ?? []).map(s => [s.id, s.section_name ?? s.name ?? String(s.id)]));
sectionCount += sections.size;

// Index every question record by its uuid AND its inner question_id,
// so parent_id references resolve regardless of which one it points at.
const byAnyId = new Map();
const rows = [];
for (const q of d.questions ?? []) {
  let j = q.question_data_json;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { j = {}; } }
  const row = { rec: q, j: j ?? {} };
  rows.push(row);
  if (q.uuid) byAnyId.set(q.uuid, row);
  if (row.j.question_id) byAnyId.set(row.j.question_id, row);
}

for (const { rec, j } of rows) {
  const sid = rec.sureify_id || j.sureify_id;
  if (!sid) continue;                              // groups/breadcrumbs without identity
  if (catalog[sid] && catalog[sid].questionnaire !== questionnaire.name) {
    console.warn(`warn: sureify_id "${sid}" appears in both ${catalog[sid].questionnaire} and ${questionnaire.name}; keeping the latter`);
  }

  const options = Array.isArray(j.response_options)
    ? j.response_options.map(o => o?.label).filter(Boolean) : [];
  if (options.length) withOptions++;

  const parentRow = rec.parent_id ? byAnyId.get(rec.parent_id) : undefined;
  const parentSid = parentRow?.rec.sureify_id || parentRow?.j?.sureify_id || null;
  const condition = rec.parent_question_answer || null;
  if (condition) reflexive++;

  catalog[sid] = {
    questionnaire: questionnaire.name,
    questionnaireType: questionnaire.type,
    label: j.question_text ?? '',
    displayType: j.display_type ?? '',
    questionType: j.question_type ?? '',
    section: sections.get(rec.application_section_id) ?? null,
    pageType: rec.page_type ?? null,
    pageOrder: rec.page_order ?? null,
    optionLabels: options,
    // Studio exports carry validations either as a list of rule objects or as an
    // object keyed by rule name ({ required: { value: true, error_message } }).
    // Keep only the rule names that are switched on.
    validations: Array.isArray(j.validations)
      ? j.validations.map(v => v?.type ?? v?.name ?? v).filter(Boolean)
      : j.validations && typeof j.validations === 'object'
        ? Object.entries(j.validations).filter(([, v]) => v?.value !== false).map(([k]) => k)
        : [],
    isListChild: !!rec.is_repeatable_group_question,
    reflexive: condition ? { parent: parentSid, condition } : null,
    roles: ['insured','owner','payor','agent'].filter(r => rec[`role_${r}`]),
  };
}
} // end per-export loop

fs.mkdirSync(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  _meta: {
    sources,
    generated: new Date().toISOString(),
    note: 'Authoring catalog only. Runtime IDs always come from live responses.',
  },
  questions: catalog,
}, null, 2));

console.log(`catalog: ${Object.keys(catalog).length} sureify_ids from ${sources.length} questionnaire(s) [${sources.map(s => `${s.name}:${s.type}`).join(', ')}] | ${withOptions} with options | ${reflexive} reflexive | sections: ${sectionCount}`);
