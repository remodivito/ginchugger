// SPDX-License-Identifier: GPL-3.0-or-later
// How each playbook rule maps onto a ContractNLI hypothesis, and which of the dataset's labels is a departure from the
// mutual-NDA position the playbook takes. The dataset labels what the contract *says* (Entailment / Contradiction /
// NotMentioned relative to the hypothesis); the playbook says what we *want*. For most rules the hypothesis states the
// balanced position, so Contradiction departs; for three it states the one-sided position, so Entailment departs.
//
// Silence. The playbook's acceptable position for six rules is "the agreement is silent" (silentOk), so a departure flag
// on a NotMentioned pair is a false alarm there. For the other rules the playbook wants the term present, so a flag on a
// NotMentioned pair is an omission the dataset neither confirms nor denies; those are reported, not scored (the 14 Oct
// calibration showed the reviewer treats such omissions, and positions inferred from other clauses, as departures, which
// the dataset's labels cannot adjudicate).
export const RULES = {
  'NDA-01': { hypothesis: 'nda-1', departs: 'Entailment', silentOk: false },     // everything must be expressly identified: one-sided
  'NDA-02': { hypothesis: 'nda-2', departs: 'Entailment', silentOk: false },     // confidential information limited to technical: one-sided
  'NDA-03': { hypothesis: 'nda-3', departs: 'Contradiction', silentOk: false },  // oral information may be confidential
  'NDA-04': { hypothesis: 'nda-4', departs: 'Contradiction', silentOk: false },  // use only for the purpose
  'NDA-05': { hypothesis: 'nda-5', departs: 'Contradiction', silentOk: false },  // sharing with employees who need to know
  'NDA-07': { hypothesis: 'nda-7', departs: 'Contradiction', silentOk: false },  // sharing with advisers and other representatives
  'NDA-08': { hypothesis: 'nda-8', departs: 'Contradiction', silentOk: false },  // notice before compelled disclosure
  'NDA-10': { hypothesis: 'nda-10', departs: 'Contradiction', silentOk: true },  // existence of the agreement confidential
  'NDA-11': { hypothesis: 'nda-11', departs: 'Contradiction', silentOk: true },  // no reverse engineering
  'NDA-12': { hypothesis: 'nda-12', departs: 'Contradiction', silentOk: true },  // independent development excluded
  'NDA-13': { hypothesis: 'nda-13', departs: 'Contradiction', silentOk: true },  // information from third parties excluded
  'NDA-15': { hypothesis: 'nda-15', departs: 'Contradiction', silentOk: true },  // no licence granted
  'NDA-16': { hypothesis: 'nda-16', departs: 'Contradiction', silentOk: true },  // return or destroy on termination
  'NDA-17': { hypothesis: 'nda-17', departs: 'Contradiction', silentOk: false }, // copies permitted for the purpose
  'NDA-18': { hypothesis: 'nda-18', departs: 'Entailment', silentOk: false },    // non-solicitation in an NDA: one-sided, out of place
  'NDA-19': { hypothesis: 'nda-19', departs: 'Contradiction', silentOk: false }, // obligations survive termination
  'NDA-20': { hypothesis: 'nda-20', departs: 'Contradiction', silentOk: false }, // limited retention after return or destruction
};
export const CHOICES = ['Entailment', 'Contradiction', 'NotMentioned'];
// The dataset label -> what the dataset says about the playbook: departs, complies, or silent.
export function verdictOf(ruleId, choice) {
  if (choice === 'NotMentioned') return 'silent';
  return choice === RULES[ruleId].departs ? 'departs' : 'complies';
}
