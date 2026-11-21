# Smart Vote — Security Specification (Phase 0 Security TDD)

## 1. Data Invariants

1. **Zero-Trust RBAC**: Only verified Google-authenticated Election Administrators (`admins/{uid}` or bootstrapped primary admin with `email_verified == true`) may create/modify elections, manage candidates, provision ESP32 booths, close polls, or unseal results. Polling Officers cannot self-escalate their `role` to `admin`.
2. **Database-Enforced Result Sealing**: Reads (`get` and `list`) on `/elections/{electionId}/sealed_tallies/official` and `/elections/{electionId}/ballots/{ballotId}` MUST be denied by Firestore rules unless the requester is an Election Administrator AND the parent election has `status == 'closed'` AND `resultsUnsealed == true`.
3. **Strict Ballot Anonymity**: Documents in `/elections/{electionId}/ballots/{ballotId}` MUST NOT allow `voterId`, `voterIdNumber`, or `fingerprintTemplateId` keys (`hasOnly` allowlist). Documents in `/voters/{voterId}` MUST NOT allow `candidateId` or raw biometric blob keys.
4. **Anti-Duplicate Terminal Lock**: Once `voters/{voterId}.hasVoted == true`, Polling Officers cannot revert `hasVoted` back to `false` or alter voting timestamps.
5. **Unseal Lifecycle Gate**: An election cannot transition `resultsUnsealed` from `false` to `true` while `status` is `'draft'` or `'active'`. Unsealing is permitted ONLY when `existing().status == 'closed'` by an Admin with `unsealedBy == request.auth.uid` and `unsealedAt == request.time`.
6. **Immutable Audit Trail**: Documents in `/audit_logs/{logId}` are strictly append-only (`allow update: if false; allow delete: if false;` for all roles including Admins).
7. **PII Isolation**: `/users/{uid}` contains `email` and is readable only by the owning user or an Election Administrator.

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Path | Expected Result |
|---|---------------|-------------|-----------------|
| 1 | Premature Tally Read (Active Election) | `GET /elections/el_1/sealed_tallies/official` (as Admin while `status == 'active'`) | `PERMISSION_DENIED` |
| 2 | Officer Tally Read After Unseal | `GET /elections/el_1/sealed_tallies/official` (as Officer after unseal) | `PERMISSION_DENIED` |
| 3 | Premature Unseal While Active | `UPDATE /elections/el_1` `{ resultsUnsealed: true }` while `status == 'active'` | `PERMISSION_DENIED` |
| 4 | Privilege Escalation on Signup | `CREATE /users/attacker_uid` `{ role: 'admin' }` (non-bootstrapped user) | `PERMISSION_DENIED` |
| 5 | Role Self-Elevation on Update | `UPDATE /users/officer_uid` `{ role: 'admin' }` (as Officer) | `PERMISSION_DENIED` |
| 6 | Shadow Field Injection (Ballot Deanonymization) | `CREATE /elections/el_1/ballots/b1` with ghost field `voterId: "V-001"` | `PERMISSION_DENIED` |
| 7 | Double-Vote Reset Attack | `UPDATE /voters/v1` `{ hasVoted: false }` (as Officer when `existing.hasVoted == true`) | `PERMISSION_DENIED` |
| 8 | Audit Log Tampering | `UPDATE /audit_logs/log1` `{ summary: "erased" }` (even as Admin) | `PERMISSION_DENIED` |
| 9 | Audit Log Deletion | `DELETE /audit_logs/log1` (even as Admin) | `PERMISSION_DENIED` |
| 10 | Unverified Admin Email Spoofing | Any write with `email == adminEmail` and `email_verified: false` | `PERMISSION_DENIED` |
| 11 | Cross-User PII Scraping | `GET /users/other_uid` (as Officer) | `PERMISSION_DENIED` |
| 12 | Oversized ID / Resource Poisoning | `CREATE /voters/<200-char-invalid-id>` or `fullName` > 120 chars | `PERMISSION_DENIED` |
