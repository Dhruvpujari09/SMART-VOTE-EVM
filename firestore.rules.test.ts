/**
 * Phase 0 Security TDD Specification for Smart Vote Firestore Rules
 * Verifies all "Dirty Dozen" adversarial payloads are rejected with PERMISSION_DENIED.
 * Run against the Firebase Emulator Suite (`@firebase/rules-unit-testing`).
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  actor: 'admin' | 'officer' | 'unverified_admin' | 'unauthenticated';
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Premature Tally Read While Election Active',
    actor: 'admin',
    operation: 'get',
    path: '/elections/el_2026/sealed_tallies/official',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Polling Officer Attempting To Read Unsealed Tally',
    actor: 'officer',
    operation: 'get',
    path: '/elections/el_closed_unsealed/sealed_tallies/official',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Admin Attempting To Unseal Results Before Closing Polls',
    actor: 'admin',
    operation: 'update',
    path: '/elections/el_2026',
    payload: { resultsUnsealed: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Self-Assigned Admin Role During Registration',
    actor: 'officer',
    operation: 'create',
    path: '/users/officer_new',
    payload: {
      uid: 'officer_new',
      email: 'rogue@example.com',
      displayName: 'Rogue User',
      role: 'admin',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Officer Self-Escalating Role To Admin',
    actor: 'officer',
    operation: 'update',
    path: '/users/officer_1',
    payload: { role: 'admin' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Ballot Deanonymization Ghost Field Injection',
    actor: 'officer',
    operation: 'create',
    path: '/elections/el_2026/ballots/ballot_rogue',
    payload: {
      electionId: 'el_2026',
      candidateId: 'cand_1',
      boothId: 'booth_1',
      constituency: 'North District',
      receiptHash: 'abc123456789',
      idempotencyKey: 'idem_123456789',
      syncMode: 'online',
      voterId: 'LEAKED_VOTER_ID',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Officer Reverting hasVoted Flag On Already-Voted Voter',
    actor: 'officer',
    operation: 'update',
    path: '/voters/voter_already_voted',
    payload: { hasVoted: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Admin Attempting To Modify Immutable Audit Log',
    actor: 'admin',
    operation: 'update',
    path: '/audit_logs/log_001',
    payload: { summary: 'Tampered entry' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Admin Attempting To Delete Immutable Audit Log',
    actor: 'admin',
    operation: 'delete',
    path: '/audit_logs/log_001',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Unverified Email Spoofing Bootstrapped Admin',
    actor: 'unverified_admin',
    operation: 'create',
    path: '/elections/el_spoof',
    payload: { title: 'Spoofed Election' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Officer Scraping Another Staff Member PII Profile',
    actor: 'officer',
    operation: 'get',
    path: '/users/admin_uid',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Resource Poisoning With Invalid Document ID & Oversized String',
    actor: 'officer',
    operation: 'create',
    path: '/voters/invalid$id!with*symbols',
    payload: { fullName: 'A'.repeat(250) },
    expected: 'PERMISSION_DENIED',
  },
];
