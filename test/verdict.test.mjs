// The oracle's verdict has three possible shapes, and the two that are
// NOT "green" must not be confused with each other.
//
//   green        the measurement happened and agreed
//   divergence   the measurement happened and the ports disagreed
//   incomplete   the measurement DID NOT HAPPEN -- a participant was absent
//   missing      the measurement DID NOT HAPPEN -- the suite was not there
//
// The defect this file exists for: a suite that failed because two ports
// were not built reported "29 fail", and the oracle called that a
// DIVERGENCE and filed it in newDivergences -- the bucket a human reads
// to decide which port is wrong. Two ports that were never run cannot
// disagree with anything.
//
// The mirror image is also here: a MISSING suite used to `continue` without
// setting `failed`, so a run over ZERO suites reported green. Absence
// became success on one side and conflict on the other. Neither is honest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { missingParticipantsOf, classify } from '../oracle.mjs';

test('the suite\'s own report of an absent participant is read', () => {
  const out = '  FAIL d29-unlicensed-action-is-orphaned  [participants missing: cs, c]\n  0 pass, 29 fail, 0 skip (of 29)';
  assert.deepEqual(missingParticipantsOf(out), ['cs', 'c']);
});

test('a clean suite report yields no absent participants', () => {
  assert.deepEqual(missingParticipantsOf('  PASS d29-unlicensed-action-is-orphaned\n  29 pass, 0 fail, 0 skip (of 29)'), []);
});

test('a report that says nothing about participants yields none', () => {
  assert.deepEqual(missingParticipantsOf(''), []);
  assert.deepEqual(missingParticipantsOf(undefined), []);
});

test('29 failures classify as a divergence when everybody was there', () => {
  assert.equal(classify({ fail: 29, pass: 0, total: 29 }, 'suite'), 'divergence');
});

test('29 failures with an absent participant are INCOMPLETE, not a divergence', () => {
  // The counts are identical to the divergence case above. The difference
  // is the suite's own report, and that is the whole point: the counts
  // alone cannot tell the two apart.
  const out = '  FAIL d29-unlicensed-action-is-orphaned  [participants missing: cs, c]';
  const absent = missingParticipantsOf(out);
  const counts = { fail: 29, pass: 0, total: 29 };
  const status = absent.length ? 'incomplete' : classify(counts, 'suite');
  assert.equal(status, 'incomplete');
  assert.notEqual(status, 'divergence');
});

test('a suite whose output cannot be read is unknown, never green', () => {
  assert.equal(classify({ fail: null, pass: null, agree: null }, 'suite'), 'unknown');
});

test('a suite that passed is green', () => {
  assert.equal(classify({ pass: 29, fail: 0, total: 29 }, 'suite'), 'green');
});
