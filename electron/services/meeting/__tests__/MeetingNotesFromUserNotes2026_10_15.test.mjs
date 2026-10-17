// Granola parity, stream C (2026-10-15): which note lines come from the
// user's own notes. The chunk prompt asks for `fromUserNotes` ONLY when the
// user typed notes (an ordinary meeting's prompt is unchanged), the validator
// keeps it, the reducer carries it through merges into the section bullets,
// and the V3 schema keeps it. Absent = written from the transcript.
//
// Pure modules, no Electron, no model calls. No platform branch here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '../../../../dist-electron/electron/services/meeting');
const load = (name) => import(pathToFileURL(path.join(base, name)).href);

const { validateMeetingSummaryV3 } = await load('MeetingSummaryV3.js');
const { TranscriptNormalizer } = await load('TranscriptNormalizer.js');
const { MeetingSummarySchemaValidator } = await load('MeetingSummarySchemaValidator.js');
const { MeetingSummaryReducer } = await load('MeetingSummaryReducer.js');
const { buildChunkPrompt } = await load('ChunkSummaryGenerator.js');
const { notesContextFromParams } = await load('MeetingContextAssembler.js');

const chunk = {
  chunkIndex: 0,
  text: '[5s] Me: Pricing first.\n[12s] Dana: The price is 40 per seat.',
  timeRange: { startMs: 0, endMs: 60000 },
  segments: [],
  tokenEstimate: 20,
};

function atoms(findings, extra = {}, chunkIndex = 0) {
  return {
    chunkIndex,
    timeRange: { startMs: 0, endMs: 60000 },
    brief: 'chunk brief',
    topics: [], decisions: [], actionItems: [], openQuestions: [], risks: [], deadlines: [],
    people: [], importantQuotes: [],
    modeSpecificFindings: findings,
    ...extra,
  };
}

test('prompt: no user notes, no fromUserNotes anywhere (byte-identical to before)', () => {
  const p = buildChunkPrompt({ chunk, totalChunks: 1, modeNoteSections: [{ title: 'Pricing', description: 'prices' }] });
  assert.ok(!p.systemPrompt.includes('fromUserNotes'));
  assert.ok(!p.jsonShapeHint.includes('fromUserNotes'));
});

test('prompt: with user notes, the rule and the field are asked for', () => {
  const notesContext = notesContextFromParams({ userNotes: '# Pricing\n- 40 per seat?' });
  const p = buildChunkPrompt({ chunk, totalChunks: 1, notesContext, modeNoteSections: [{ title: 'Pricing', description: 'prices' }] });
  assert.match(p.systemPrompt, /fromUserNotes: true on a section finding, decision, action item or open question only when it restates or fills in a point the user wrote in THE USER'S OWN NOTES/);
  assert.match(p.systemPrompt, /Leave it false for anything that comes from the transcript alone/);
  // Section findings, decisions, action items and questions all show the field.
  assert.equal((p.jsonShapeHint.match(/"fromUserNotes": false/g) || []).length, 4);
});

test('validator keeps fromUserNotes only when it is literally true', () => {
  const v = new MeetingSummarySchemaValidator();
  const a = v.validateAndRepairAtoms({
    brief: 'x',
    decisions: [{ text: 'Price is 40 per seat', fromUserNotes: true }, { text: 'Ship Friday', fromUserNotes: 'yes' }],
    actionItems: [{ text: 'Send the quote', fromUserNotes: true }],
    openQuestions: [{ text: 'Is SSO included?', fromUserNotes: true }],
    modeSpecificFindings: { Pricing: [{ text: 'Price is 40 per seat for 50 seats', fromUserNotes: true }, { text: 'Discount talk', fromUserNotes: 1 }] },
  }, 0, { allowedSectionTitles: ['Pricing'] });
  assert.equal(a.decisions[0].fromUserNotes, true);
  assert.equal(a.decisions[1].fromUserNotes, undefined);
  assert.equal(a.actionItems[0].fromUserNotes, true);
  assert.equal(a.openQuestions[0].fromUserNotes, true);
  assert.equal(a.modeSpecificFindings.Pricing[0].fromUserNotes, true);
  assert.equal(a.modeSpecificFindings.Pricing[1].fromUserNotes, undefined);
});

test('reducer carries fromUserNotes into section bullets, through a merge, and into decisions/actions', () => {
  const reducer = new MeetingSummaryReducer();
  const normalized = new TranscriptNormalizer().normalize([{ speaker: 'user', text: 'pricing talk', timestamp: 0, final: true }]);
  const summary = reducer.reduce({
    title: 't',
    atoms: [
      atoms({ Pricing: [{ text: 'Price is 40 per seat', confidence: 'high' }, { text: 'Annual billing only', confidence: 'high' }] },
        { decisions: [{ text: 'Go with annual billing', confidence: 'high' }] }, 0),
      // A later chunk ties the same point to the user's notes, and words it more fully.
      atoms({ Pricing: [{ text: 'Price is 40 per seat annually', confidence: 'high', fromUserNotes: true }] },
        { decisions: [{ text: 'Go with annual billing', confidence: 'high', fromUserNotes: true }], actionItems: [{ text: 'Send the quote by Friday', explicitness: 'explicit', confidence: 'high', fromUserNotes: true }] }, 1),
    ],
    normalizedTranscript: normalized,
    modeTemplateType: 'sales',
    modeNoteSections: [{ title: 'Pricing' }],
  });
  const pricing = summary.sections.find((s) => s.title === 'Pricing');
  const seat = pricing.bullets.find((b) => /40 per seat/.test(b.text));
  assert.equal(seat.fromUserNotes, true, 'one chunk marking it is enough');
  assert.match(seat.text, /annually/, 'the richer text still wins');
  const billing = pricing.bullets.find((b) => /Annual billing/.test(b.text));
  assert.equal(billing.fromUserNotes, undefined, 'absent = from the transcript');
  assert.equal(summary.decisions[0].fromUserNotes, true);
  assert.equal(summary.actionItems.find((a) => /quote/.test(a.text)).fromUserNotes, true);

  // The V3 schema (what the notes are saved as) keeps it, and drops anything else.
  const valid = validateMeetingSummaryV3(summary);
  assert.equal(valid.ok, true);
  const kept = valid.data.sections[0].bullets;
  assert.equal(kept.find((b) => /40 per seat/.test(b.text)).fromUserNotes, true);
  assert.equal(kept.find((b) => /Annual billing/.test(b.text)).fromUserNotes, undefined);
});
