// SPDX-License-Identifier: GPL-3.0-or-later
// The layer C criterion list (BENCHMARK-V2.md sections 3.3 and 7), fixed before any run and copied by import.mjs into
// layer-c-tasks.json. Source: the 2 October audit (../../../eval-feasibility/redline-task-audit.md), which read every
// rubric criterion of three later-round RedlineBench inputs and classed each U (transfers as written: 9), A (transfers
// with output adaptation: 13) or I (incompatible as a mandatory criterion: 11). The 22 U and A criteria are layer C;
// the 11 I criteria are listed with the audit's reason and never judged.
//
// For each criterion:
//   kind     'change'  the attorney's action changes the text (delete, insert, reject an incoming change): the output
//                      passes only by proposing that change (or one with the same effect);
//            'keep'    the attorney's action leaves an incoming change in place ("Accepts ..."): the output passes when
//                      no proposed change removes, reverses or weakens it, as RedlineBench's own judge reads "Accepts"
//                      (tests/judge_prompts.py: "PASS iff the opposing-side change is left structurally intact").
//   adapted  the wording the judges see: the attorney's criterion restated for a review that proposes changes (the
//            product writes no tracked changes or comments), anchored on quoted text from the task document because
//            the document's section numbers are list numbering the text does not carry. Written from the rubric, the
//            audit's notes and the task document; the attorney's own criterion and justification stay beside it.
//   expect   the panel validity control's expected verdicts (section 7): the golden redline passes every criterion;
//            the empty output fails every 'change' criterion and passes every 'keep' criterion (an empty output does leave every
//            incoming change in place; panel.mjs and the report explain this reading of section 7).
// Ids: C-<scenario>-<nn>, in the audit's order. Weights are the attorneys' and are recorded, never used in a score.

export const SELECTION = {
  'redline-s1-t3-g01a': {
    criteria: [
      { id: 'C-s1-01', rubricId: 'rubric_1778170166070_fze5i', class: 'U', kind: 'keep', section: '1.7',
        adapted: 'Section 1.7, the definition of "Derivative Work" ("“Derivative Work” means a work which is based upon one or more preexisting works ..."), which LargeCo restored, stays in the agreement: no proposed change deletes the definition or removes the defined term.' },
      { id: 'C-s1-02', rubricId: 'rubric_1778279895663_xwc1a', class: 'A', kind: 'change', section: '1.19',
        adapted: 'In the definition of "User Information" (Section 1.19), the output proposes deleting the reference to "User data" (limb (b): "all User data that is generated, collected, stored, processed or used in connection with or derived from Provider’s performance of the Services"), so the definition no longer conflicts with the statement at its end about what User Information does not include. Wording with the same effect counts; an explanation without a proposed change does not.' },
      { id: 'C-s1-03', rubricId: 'rubric_1778280533741_f4jsc', class: 'A', kind: 'change', section: '2.2',
        adapted: 'In Section 2.2 (LargeCo\'s paragraph beginning "LargeCo may permit its Affiliates and their Authorized Users to access and use the Services"), the output proposes deleting the word "Authorized", so the provision refers to "Users" (the defined term) rather than "Authorized Users" (Provider personnel given access to LargeCo systems). Deleting it at each place in that paragraph, or wording with the same effect, counts.' },
      { id: 'C-s1-04', rubricId: 'rubric_1778626575064_vbamo', class: 'U', kind: 'keep', section: '2.3.2',
        adapted: 'In Section 2.3.2, LargeCo\'s inserted sentence "The foregoing does not authorize Provider to disclose LargeCo’s actual AI Inputs or AI Outputs (in whole or part) to any third party, and any AI Input or AI Output that contains LargeCo Data, User Information, Personal Information, or other LargeCo Confidential Information remains LargeCo’s Confidential Information regardless of similarity to inputs or outputs of other customers" stays in substance: no proposed change deletes or weakens it.' },
      { id: 'C-s1-05', rubricId: 'rubric_1778626785236_uokwz', class: 'U', kind: 'change', section: '2.3.2',
        adapted: 'In Section 2.3.2, the output proposes restoring the sentence LargeCo deleted, "Queries submitted by, and responses delivered to other customers and their users do not constitute LargeCo’s Confidential Information", or wording with the same effect (outputs delivered to other customers are not LargeCo\'s Confidential Information merely because they resemble LargeCo\'s).' },
      { id: 'C-s1-06', rubricId: 'rubric_1778627032732_o08ok', class: 'A', kind: 'change', section: '2.3.4',
        adapted: 'In Section 2.3.4 (Third-Party AI Technology), item (c) reads "... a written agreement with the licensor of such AI Technology that imposes obligations that impose obligations substantially consistent ...". The output proposes deleting the duplicated words "that impose obligations" that LargeCo inserted, leaving the clause otherwise as it stands.' },
      { id: 'C-s1-07', rubricId: 'rubric_1778284114514_h2o5q', class: 'U', kind: 'keep', section: '2.3.4',
        adapted: 'In Section 2.3.4 (Third-Party AI Technology), item (c), LargeCo\'s replacement of "at least as restrictive as those imposed on or required of Provider" with "substantially consistent with the relevant obligations of Provider" stays: no proposed change restores "at least as restrictive" or otherwise makes the standard stricter.' },
      { id: 'C-s1-08', rubricId: 'rubric_1778280982895_peq13', class: 'A', kind: 'change', section: '3.1',
        adapted: 'In Section 3.1 (Restrictions), item (f) prohibits probing, scanning or attempting to penetrate the Service, and LargeCo added "except for security testing of LargeCo’s own configuration, integrations, and Authorized User behavior or as otherwise expressly permitted by Provider in writing". The output proposes removing that exception, or rewriting it so that LargeCo gains no right to test, probe or scan Provider\'s systems beyond what Provider permits in writing.' },
      { id: 'C-s1-09', rubricId: 'rubric_1778628747533_53cse', class: 'U', kind: 'keep', section: '8',
        adapted: 'LargeCo\'s inserted Section 8, "Term and Termination" (heading "TERM AND TERMINATION." and its subsections), stays in the agreement as a section: no proposed change deletes the section as a whole. Changes to individual termination rights, renumbering or cross-reference corrections do not count against this criterion.' },
      { id: 'C-s1-10', rubricId: 'rubric_1778629615266_d8qvf', class: 'A', kind: 'change', section: '14.1',
        adapted: 'In Section 14.1 (General Cap), LargeCo inserted a floor so the cap is "the greater of (a) the total of all payments actually received by Provider ... during the twelve (12) month period ... or (b) US$1,000,000". The output proposes deleting the US$1,000,000 alternative so the general cap is the fees paid in the preceding twelve months.' },
      { id: 'C-s1-11', rubricId: 'rubric_1778282563375_ie4qn', class: 'A', kind: 'change', section: '16.7',
        adapted: 'The output proposes removing LargeCo\'s inserted "Exceptions to Indirect-Damages Exclusion. The exclusion set forth in Section 11.4 shall not apply to, and shall not limit liability arising from: (i) Provider\'s breach of Confidentiality; (ii) Provider\'s breach of Training; (iii) Provider\'s breach of Data Security or Exhibit C; (iv) any Party\'s indemnification obligations; or (v) fraud, gross negligence, or willful misconduct", or a change with the same effect (the indirect-damages exclusion applies without those exceptions).' },
      { id: 'C-s1-12', rubricId: 'rubric_1778282787793_44itt', class: 'A', kind: 'change', section: '15.1',
        adapted: 'In Section 15.1 (Indemnification Obligations), LargeCo inserted item (a) "Provider\'s breach of Confidentiality, Training, Data Security, Exhibit C, or any Applicable Law applicable to Provider\'s performance under this Agreement" and item (c) "the fraud, gross negligence, or willful misconduct of Provider". The output proposes deleting both, so Provider\'s indemnity covers only third-party infringement claims (item (b)). Deleting only one of the two fails.' },
      { id: 'C-s1-13', rubricId: 'rubric_1778367242768_ne2wr', class: 'U', kind: 'keep', section: '12(k)',
        adapted: 'In the warranty disclaimer (Section 12(k), last paragraph), LargeCo\'s opening "Except for the warranties expressly set forth in this Agreement (including Sections 2.3 (AI), ... (Reps & Warranties), ... (Indemnification), and Exhibit C)" stays in substance: no proposed change deletes it or narrows the warranties it preserves. Correcting its section cross-references does not count against this criterion.' },
    ],
    excluded: [
      { rubricId: 'rubric_1778627352768_14epr', class: 'I', reason: 'A surviving embedded-technology licence is a substantive commercial grant the guidance does not settle (audit).' },
      { rubricId: 'rubric_1778627729352_xaol8', class: 'I', reason: 'Rejecting privacy safeguards as redundant needs a lawyer to confirm no protection is lost; the guidance favours confidentiality (audit).' },
      { rubricId: 'rubric_1778281577635_o8678', class: 'I', reason: 'No guidance chooses the lesser of insurance and five times fees; considering a higher cap does not authorise this formula (audit).' },
      { rubricId: 'rubric_1778366650412_gcsvm', class: 'I', reason: 'Mutual convenience termination is not established by the guidance; the precedent uses breach and insolvency termination (audit).' },
      { rubricId: 'rubric_1778629186668_mw748', class: 'I', reason: 'Removing SLA and subprocessor exit rights is unresolved; the precedent itself permits termination for unresolved subprocessor objections (audit).' },
      { rubricId: 'rubric_1778629488058_wsjwv', class: 'I', reason: 'Blanket acceptance "with edits" is not a determined response; the specific cap criteria are separate (audit).' },
      { rubricId: 'rubric_1778630731656_9x8tw', class: 'I', reason: 'SOC 2 not covering security terms does not settle whether all of Schedule 2 is commercially reasonable (audit).' },
    ],
  },
  'redline-s2-t4-g03a': {
    criteria: [
      { id: 'C-s2-01', rubricId: 'rubric_1780090370814_z7wqk', class: 'A', kind: 'keep', section: '4.3',
        adapted: 'LargeCo deleted Section 4.3, a no-training clause whose obligations Section 11.7 now carries. The deletion stays: no proposed change restores Section 4.3 or its wording. (The adaptation: consolidating under Section 11.7 is accepted on the attorney\'s reading that 11.7 preserves 4.3\'s obligations.)' },
      { id: 'C-s2-02', rubricId: 'rubric_1780090468793_2reog', class: 'U', kind: 'keep', section: '11.7',
        adapted: 'In Section 11.7 (No Training: "AgentCo will not, and will not permit any Subprocessor ... to ... train any AI model ... using Customer\'s Content or Customer Data"), LargeCo\'s inserted wording that widens the prohibition on AgentCo training AI models on LargeCo data (the added Affiliates and third-party providers, "or train, fine tune, or otherwise improve the Service", and item (b) on combining Customer Content with other customers\' data to generate generalized models or features) stays in substance: no proposed change deletes or weakens it.' },
    ],
    excluded: [
      { rubricId: 'rubric_1780082769895_bezkj', class: 'I', reason: 'No PHI today does not authorise deleting a preventive no-regulated-data covenant; the rubric\'s justification also names Section 4.3 while the criterion names 3.4 (audit).' },
    ],
  },
  'redline-s3-t4-g02a': {
    criteria: [
      { id: 'C-s3-01', rubricId: 'rubric_1780175485702_6zw9x', class: 'A', kind: 'change', section: '4.3',
        adapted: 'In Section 4.3 (Results of Service: "All Results of Service shall be accurate, complete, and in accordance with: ..."), the output proposes removing AgentCo\'s inserted item "(iii) after human review of Results of Service;", or rewording the sentence so it is unambiguous; a rewording must not drop a requirement of human review that the agreement states elsewhere.' },
      { id: 'C-s3-02', rubricId: 'rubric_1780178120084_sgbs7', class: 'U', kind: 'keep', section: '5.1',
        adapted: 'In Section 5.1, AgentCo\'s insertion of the word "applicable" stays: no proposed change removes it.' },
      { id: 'C-s3-03', rubricId: 'rubric_1780178145299_zvmmk', class: 'U', kind: 'keep', section: '6.1',
        adapted: 'In Section 6.1, AgentCo\'s inserted description "candidate-material summaries and interview-note drafting" stays: no proposed change removes or replaces it.' },
      { id: 'C-s3-04', rubricId: 'rubric_1780178175444_2xdok', class: 'A', kind: 'change', section: '6.1',
        adapted: 'In Section 6.1, the output proposes removing AgentCo\'s inserted "(collectively the “Services)", because "Services" is already a defined term.' },
      { id: 'C-s3-05', rubricId: 'rubric_1780178802342_58f90', class: 'A', kind: 'change', section: '7.5',
        adapted: 'In Section 7.5 (License to Background Intellectual Property Rights), the output proposes inserting "worldwide" (or wording with the same geographic meaning, such as "throughout the world") to state where the licence to Client applies, without extending the licence beyond that geographic scope.' },
      { id: 'C-s3-06', rubricId: 'rubric_1780178229200_6q2kg', class: 'A', kind: 'change', section: '7.5',
        adapted: 'In Section 7.5 (License to Background Intellectual Property Rights), the output proposes removing AgentCo\'s inserted "at mutual locations" (or replacing it with clear geographic wording).' },
      { id: 'C-s3-07', rubricId: 'rubric_1780178248945_pwoht', class: 'A', kind: 'keep', section: '7.5',
        adapted: 'In Section 7.5 (License to Background Intellectual Property Rights), AgentCo\'s deletion of "everywhere" stays: no proposed change restores the word "everywhere". Replacing it with "worldwide" or equivalent clear wording is consistent with this criterion.' },
    ],
    excluded: [
      { rubricId: 'rubric_1780178191520_ci0ap', class: 'I', reason: 'No evidence that a vendor portal exists cannot settle whether deleting the policy-access language is acceptable (audit).' },
      { rubricId: 'rubric_1780178340016_om6yv', class: 'I', reason: 'Revocability on customer breach is a substantive IP-licence choice with no approved fallback (audit).' },
      { rubricId: 'rubric_1780178393941_3vos1', class: 'I', reason: 'A general request for stronger remedies does not settle this payment, IP and indemnity carve-out package (audit).' },
    ],
  },
};

/** Expected validity-control verdicts for a criterion (section 7). */
export const expectFor = c => ({ golden: true, empty: c.kind === 'keep' });
