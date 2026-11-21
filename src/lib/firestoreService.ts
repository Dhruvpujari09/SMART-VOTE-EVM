import { reauthenticateWithPopup, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  type DocumentReference,
  getDoc,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  BOOTSTRAPPED_ADMIN_EMAIL,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  buildCompactEsp32BallotPayload,
  computeSha256Hex,
  PARTY_EMBLEM_PRESETS,
} from './validation';
import type {
  AuditCategory,
  AuditSeverity,
  BoothStatus,
  BoothSyncState,
  Candidate,
  Election,
  EvmBooth,
  OfflineQueuedVote,
  TamperState,
  UserProfile,
  UserRole,
  Voter,
} from '../types/evm';

function makeId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}

function clampStr(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

export async function ensureUserProfile(firebaseUser: User): Promise<UserProfile> {
  const userRef = doc(db, 'users', firebaseUser.uid);
  const path = `users/${firebaseUser.uid}`;
  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }

    const isPrimaryAdmin =
      firebaseUser.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase() &&
      firebaseUser.emailVerified;

    const newProfile = {
      uid: firebaseUser.uid,
      email: clampStr(firebaseUser.email || 'unknown@smartvote.local', 160),
      displayName: clampStr(
        firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Election Officer',
        120
      ),
      role: (isPrimaryAdmin ? 'admin' : 'officer') as UserRole,
      assignedConstituency: 'All Constituencies',
      ...(firebaseUser.photoURL ? { photoUrl: clampStr(firebaseUser.photoURL, 500) } : {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, newProfile);

    // Bootstrap primary admin allowlist doc if primary admin
    if (isPrimaryAdmin) {
      try {
        await setDoc(doc(db, 'admins', firebaseUser.uid), {
          uid: firebaseUser.uid,
          email: newProfile.email,
          grantedBy: firebaseUser.uid,
          createdAt: serverTimestamp(),
        });
      } catch {
        // Bootstrapped admin already passes rules via email check
      }
    }

    const createdSnap = await getDoc(userRef);
    return (createdSnap.data() as UserProfile) || {
      ...newProfile,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function appendAuditLog(params: {
  category: AuditCategory;
  action: string;
  severity: AuditSeverity;
  actorRole: 'admin' | 'officer' | 'esp32';
  summary: string;
  boothId?: string | null;
  electionId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const user = auth.currentUser;
  if (!user) return;

  const logId = makeId('log');
  const path = `audit_logs/${logId}`;
  try {
    await setDoc(doc(db, 'audit_logs', logId), {
      category: params.category,
      action: clampStr(params.action, 80),
      severity: params.severity,
      actorUid: user.uid,
      actorEmail: clampStr(user.email || 'staff@smartvote.local', 160),
      actorRole: params.actorRole,
      ...(params.boothId ? { boothId: clampStr(params.boothId, 128) } : {}),
      ...(params.electionId ? { electionId: clampStr(params.electionId, 128) } : {}),
      summary: clampStr(params.summary, 400),
      ...(params.metadata ? { metadata: params.metadata } : {}),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function createElectionRecord(params: {
  title: string;
  description: string;
  constituencies: string[];
  startTime: string;
  endTime: string;
}): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Authentication required');

  const electionId = makeId('el');
  const constituencies = params.constituencies
    .map((c) => clampStr(c, 80))
    .filter(Boolean)
    .slice(0, 20);
  if (constituencies.length === 0) {
    throw new Error('At least one constituency is required.');
  }

  const initialHash = await computeSha256Hex(`${electionId}:v1:${constituencies.join(',')}`);
  const batch = writeBatch(db);

  batch.set(doc(db, 'elections', electionId), {
    title: clampStr(params.title, 120),
    description: clampStr(params.description, 500),
    constituencies,
    startTime: clampStr(params.startTime, 40),
    endTime: clampStr(params.endTime, 40),
    status: 'draft',
    resultsUnsealed: false,
    ballotVersion: 1,
    ballotHash: initialHash,
    totalRegisteredVoters: 0,
    totalVotesCast: 0,
    validationPassed: false,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Create sealed tally accumulator alongside election
  batch.set(doc(db, 'elections', electionId, 'sealed_tallies', 'official'), {
    electionId,
    counts: {},
    totalTallied: 0,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      category: 'ADMIN',
      action: 'ELECTION_CREATED',
      severity: 'info',
      actorRole: 'admin',
      electionId,
      summary: `Created draft election "${clampStr(params.title, 80)}" across ${constituencies.length} constituency(ies).`,
      metadata: { constituencies },
    });
    return electionId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `elections/${electionId}`);
  }
}

export async function updateElectionSchedule(
  electionId: string,
  updates: {
    title: string;
    description: string;
    startTime: string;
    endTime: string;
    constituencies: string[];
  }
) {
  const path = `elections/${electionId}`;
  try {
    await updateDoc(doc(db, 'elections', electionId), {
      title: clampStr(updates.title, 120),
      description: clampStr(updates.description, 500),
      startTime: clampStr(updates.startTime, 40),
      endTime: clampStr(updates.endTime, 40),
      constituencies: updates.constituencies.map((c) => clampStr(c, 80)).filter(Boolean).slice(0, 20),
      validationPassed: false,
      updatedAt: serverTimestamp(),
    });
    await appendAuditLog({
      category: 'ADMIN',
      action: 'ELECTION_UPDATED',
      severity: 'info',
      actorRole: 'admin',
      electionId,
      summary: `Updated schedule and configuration for election "${clampStr(updates.title, 80)}".`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function addCandidateRecord(params: {
  electionId: string;
  name: string;
  party: string;
  constituency: string;
  ballotNumber: number;
  symbolUrl: string;
  accentColor: string;
}): Promise<string> {
  const candidateId = makeId('cand');
  const path = `elections/${params.electionId}/candidates/${candidateId}`;
  try {
    await setDoc(doc(db, 'elections', params.electionId, 'candidates', candidateId), {
      electionId: params.electionId,
      name: clampStr(params.name, 100),
      party: clampStr(params.party, 100),
      constituency: clampStr(params.constituency, 80),
      ballotNumber: Math.max(1, Math.min(99, Math.round(params.ballotNumber))),
      symbolUrl: clampStr(params.symbolUrl, 500),
      accentColor: clampStr(params.accentColor, 20),
      createdAt: serverTimestamp(),
    });

    await appendAuditLog({
      category: 'ADMIN',
      action: 'CANDIDATE_ADDED',
      severity: 'info',
      actorRole: 'admin',
      electionId: params.electionId,
      summary: `Added candidate ${clampStr(params.name, 60)} (${clampStr(params.party, 40)}) to ${params.constituency} at keypad #${params.ballotNumber}.`,
    });
    return candidateId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteCandidateRecord(electionId: string, candidate: Candidate) {
  const path = `elections/${electionId}/candidates/${candidate.id}`;
  try {
    await deleteDoc(doc(db, 'elections', electionId, 'candidates', candidate.id));
    await appendAuditLog({
      category: 'ADMIN',
      action: 'CANDIDATE_REMOVED',
      severity: 'warning',
      actorRole: 'admin',
      electionId,
      summary: `Removed candidate ${candidate.name} (${candidate.party}) from ${candidate.constituency}.`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function pushValidatedBallotToBooths(params: {
  election: Election;
  candidates: Candidate[];
  booths: EvmBooth[];
  activatePolls?: boolean;
}): Promise<{ ballotVersion: number; ballotHash: string; pushedCount: number }> {
  const { election, candidates, booths, activatePolls } = params;
  const nextVersion = election.ballotVersion + 1;
  const compactJson = buildCompactEsp32BallotPayload(
    { ...election, ballotVersion: nextVersion },
    candidates
  );
  const ballotHash = await computeSha256Hex(compactJson);
  const targetBooths = booths.filter((b) => b.electionId === election.id);

  const batch = writeBatch(db);
  batch.update(doc(db, 'elections', election.id), {
    ballotVersion: nextVersion,
    ballotHash,
    validationPassed: true,
    lastPushedAt: serverTimestamp(),
    ...(activatePolls && election.status === 'draft' ? { status: 'active' } : {}),
    updatedAt: serverTimestamp(),
  });

  const issuedAt = new Date().toISOString();
  for (const booth of targetBooths) {
    const command = {
      commandId: makeId('cmd'),
      type: 'SYNC_BALLOT',
      issuedAt,
      ballotVersion: nextVersion,
      ballotHash,
    };
    batch.update(doc(db, 'booths', booth.id), {
      pendingCommand: command,
      ...(booth.status === 'online' || booth.status === 'degraded'
        ? {
            ballotVersion: nextVersion,
            lcdMessage: `BALLOT V${nextVersion} SYNCED`,
          }
        : {}),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();

    // Push immediately over Express/WebSocket gateway to connected ESP32 hardware
    for (const booth of targetBooths) {
      void fetch('/api/gateway/dispatch-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boothId: booth.id,
          command: {
            type: 'SYNC_BALLOT',
            ballotVersion: nextVersion,
            ballotHash,
          },
        }),
      }).catch(() => undefined);
    }

    await appendAuditLog({
      category: 'ADMIN',
      action: activatePolls ? 'ELECTION_OPENED_AND_PUSHED' : 'BALLOT_PUSHED_TO_ESP32',
      severity: 'info',
      actorRole: 'admin',
      electionId: election.id,
      summary: `${activatePolls ? 'Opened polls and pushed' : 'Pushed'} validated ballot v${nextVersion} (SHA-256 ${ballotHash.slice(0, 12)}…) to ${targetBooths.length} ESP32 booth(s).`,
      metadata: {
        ballotVersion: nextVersion,
        ballotHash,
        boothCount: targetBooths.length,
      },
    });

    return { ballotVersion: nextVersion, ballotHash, pushedCount: targetBooths.length };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `elections/${election.id}`);
  }
}

export async function closeElectionPolls(election: Election, booths: EvmBooth[]) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'elections', election.id), {
    status: 'closed',
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const electionBooths = booths.filter((b) => b.electionId === election.id);
  for (const booth of electionBooths) {
    batch.update(doc(db, 'booths', booth.id), {
      lcdMessage: 'POLLS CLOSED - LOCKED',
      pendingCommand: {
        commandId: makeId('cmd'),
        type: 'LOCK_BOOTH',
        issuedAt: new Date().toISOString(),
      },
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    await appendAuditLog({
      category: 'ADMIN',
      action: 'POLLS_CLOSED',
      severity: 'warning',
      actorRole: 'admin',
      electionId: election.id,
      summary: `Closed polling for "${election.title}". Tallies remain sealed in Firestore pending re-authenticated Admin unseal.`,
      metadata: {
        totalVotesCast: election.totalVotesCast,
        totalRegisteredVoters: election.totalRegisteredVoters,
      },
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `elections/${election.id}`);
  }
}

/**
 * Requires live Google re-authentication before unsealing results on a closed election,
 * enforced at the Firestore security rules level and logged atomically in audit_logs.
 */
export async function unsealElectionResultsWithReauth(election: Election): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('You must be signed in as an Election Administrator.');
  }
  if (election.status !== 'closed') {
    throw new Error('Polls must be closed before results can be unsealed.');
  }

  // Step 1: Mandatory fresh Google re-authentication
  await reauthenticateWithPopup(currentUser, googleProvider);

  // Step 2: Atomic Firestore update flipping resultsUnsealed = true + immutable UNSEAL audit log
  const batch = writeBatch(db);
  batch.update(doc(db, 'elections', election.id), {
    resultsUnsealed: true,
    unsealedBy: currentUser.uid,
    unsealedByEmail: clampStr(currentUser.email || 'admin@smartvote.local', 160),
    unsealedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const logId = makeId('log');
  batch.set(doc(db, 'audit_logs', logId), {
    category: 'UNSEAL',
    action: 'RESULTS_UNSEALED_AFTER_REAUTH',
    severity: 'critical',
    actorUid: currentUser.uid,
    actorEmail: clampStr(currentUser.email || 'admin@smartvote.local', 160),
    actorRole: 'admin',
    electionId: election.id,
    summary: `Election Administrator ${currentUser.email} completed Google re-authentication and unsealed official candidate tallies for "${election.title}".`,
    metadata: {
      reauthenticatedAt: new Date().toISOString(),
      totalVotesCast: election.totalVotesCast,
    },
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `elections/${election.id}`);
  }
}

export async function provisionEsp32Booth(params: {
  boothCode: string;
  name: string;
  constituency: string;
  electionId: string;
  firmwareVersion?: string;
}): Promise<{ boothId: string; plainApiKey: string }> {
  const boothId = makeId('booth');
  const rawSecret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const plainApiKey = `sv_esp32_${rawSecret}`;
  const apiKeyPrefix = plainApiKey.slice(0, 14);
  const apiKeyHash = await computeSha256Hex(plainApiKey);

  const path = `booths/${boothId}`;
  try {
    await setDoc(doc(db, 'booths', boothId), {
      boothCode: clampStr(params.boothCode.toUpperCase(), 32),
      name: clampStr(params.name, 100),
      constituency: clampStr(params.constituency, 80),
      electionId: params.electionId,
      apiKeyPrefix,
      apiKeyHash,
      status: 'online' as BoothStatus,
      syncState: 'synced' as BoothSyncState,
      wifiRssi: -56,
      syncLatencyMs: 38,
      batteryPct: 98,
      firmwareVersion: clampStr(params.firmwareVersion || '2.4.1-esp32', 32),
      ballotVersion: 1,
      votesCast: 0,
      pendingOfflineVotes: 0,
      offlineQueueBytes: 0,
      localConflictCount: 0,
      tamperState: 'nominal' as TamperState,
      lcdMessage: 'READY - PLACE FINGER',
      pendingCommand: null,
      lastHeartbeatAt: serverTimestamp(),
      lastSyncAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await appendAuditLog({
      category: 'ADMIN',
      action: 'ESP32_BOOTH_PROVISIONED',
      severity: 'info',
      actorRole: 'admin',
      boothId,
      electionId: params.electionId,
      summary: `Provisioned ESP32 booth ${params.boothCode.toUpperCase()} (${params.name}) in ${params.constituency} with TLS/API key prefix ${apiKeyPrefix}….`,
    });

    return { boothId, plainApiKey };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function registerVoterRecord(params: {
  fullName: string;
  voterIdNumber: string;
  constituency: string;
  electionId: string;
  actorRole: UserRole;
}): Promise<string> {
  const voterId = makeId('voter');
  const batch = writeBatch(db);

  batch.set(doc(db, 'voters', voterId), {
    fullName: clampStr(params.fullName, 120),
    voterIdNumber: clampStr(params.voterIdNumber.toUpperCase(), 40),
    constituency: clampStr(params.constituency, 80),
    electionId: params.electionId,
    enrollmentStatus: 'pending',
    fingerprintTemplateId: null,
    enrolledBoothId: null,
    hasVoted: false,
    votedBoothId: null,
    votedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.update(doc(db, 'elections', params.electionId), {
    totalRegisteredVoters: increment(1),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      category: params.actorRole === 'admin' ? 'ADMIN' : 'OFFICER',
      action: 'VOTER_REGISTERED',
      severity: 'info',
      actorRole: params.actorRole,
      electionId: params.electionId,
      summary: `Registered voter ${params.voterIdNumber.toUpperCase()} (${params.constituency}) pending ESP32 biometric template mapping.`,
    });
    return voterId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `voters/${voterId}`);
  }
}

export async function dispatchFingerprintEnrollmentCommand(params: {
  voter: Voter;
  booth: EvmBooth;
  actorRole: UserRole;
}): Promise<string> {
  const commandId = makeId('cmd');
  const command = {
    commandId,
    type: 'ENROLL_FINGERPRINT' as const,
    issuedAt: new Date().toISOString(),
    voterDocId: params.voter.id,
    voterName: params.voter.fullName,
  };

  const batch = writeBatch(db);
  batch.update(doc(db, 'voters', params.voter.id), {
    enrollmentStatus: 'enrolling',
    enrolledBoothId: params.booth.id,
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'booths', params.booth.id), {
    pendingCommand: command,
    lcdMessage: `ENROLL: ${params.voter.voterIdNumber.slice(0, 10)}`,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    void fetch('/api/gateway/dispatch-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boothId: params.booth.id,
        command,
      }),
    }).catch(() => undefined);

    await appendAuditLog({
      category: 'OFFICER',
      action: 'REMOTE_ENROLL_DISPATCHED',
      severity: 'info',
      actorRole: params.actorRole,
      boothId: params.booth.id,
      electionId: params.voter.electionId,
      summary: `Dispatched ENROLL_FINGERPRINT command to ${params.booth.boothCode} for voter ${params.voter.voterIdNumber}.`,
    });

    return commandId;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `voters/${params.voter.id}`);
  }
}

export async function completeFingerprintEnrollment(params: {
  voter: Voter;
  booth: EvmBooth;
  templateId: string;
  actorRole: UserRole;
}) {
  const sanitizedTemplateId = clampStr(params.templateId, 40);
  const batch = writeBatch(db);
  batch.update(doc(db, 'voters', params.voter.id), {
    enrollmentStatus: 'enrolled',
    fingerprintTemplateId: sanitizedTemplateId,
    enrolledBoothId: params.booth.id,
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'booths', params.booth.id), {
    pendingCommand: null,
    lcdMessage: `ENROLLED ${sanitizedTemplateId}`,
    lastHeartbeatAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      category: 'ESP32',
      action: 'BIOMETRIC_TEMPLATE_MAPPED',
      severity: 'info',
      actorRole: params.actorRole,
      boothId: params.booth.id,
      electionId: params.voter.electionId,
      summary: `ESP32 ${params.booth.boothCode} mapped opaque fingerprint template ${sanitizedTemplateId} to voter ${params.voter.voterIdNumber} (zero raw biometrics stored).`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `voters/${params.voter.id}`);
  }
}

/**
 * Atomic decoupled vote submission:
 * 1. Marks voter hasVoted=true (NO candidateId written to voter doc)
 * 2. Writes anonymized ballot doc (NO voterId or templateId written to ballot doc)
 * 3. Blind-increments sealed_tallies/official counts.<candidateId> (unreadable until unseal!)
 * 4. Increments live totalVotesCast on election & votesCast on booth
 */
export async function castAnonymizedVoteInFirestore(params: {
  election: Election;
  voter: Voter;
  candidate: Candidate;
  booth: EvmBooth;
  idempotencyKey: string;
  syncMode: 'online' | 'offline_reconciled';
  actorRole: UserRole;
}): Promise<{ ballotId: string; receiptHash: string }> {
  const { election, voter, candidate, booth, idempotencyKey, syncMode, actorRole } = params;

  if (election.status !== 'active') {
    throw new Error(`Election is currently ${election.status}. Votes can only be recorded while active.`);
  }
  if (voter.hasVoted) {
    await appendAuditLog({
      category: 'SECURITY',
      action: 'DUPLICATE_VOTE_BLOCKED',
      severity: 'critical',
      actorRole,
      boothId: booth.id,
      electionId: election.id,
      summary: `Blocked duplicate vote attempt for ${voter.voterIdNumber} at ${booth.boothCode} (already voted at ${voter.votedBoothId || 'another booth'}).`,
    });
    throw new Error('DUPLICATE_VOTE_BLOCKED: Voter has already cast a ballot.');
  }

  const ballotId = makeId('bal');
  const receiptHash = (
    await computeSha256Hex(`${election.id}:${candidate.id}:${booth.id}:${idempotencyKey}`)
  ).slice(0, 24);

  const batch = writeBatch(db);

  // 1. Mark voter as voted (ZERO candidate info stored here)
  batch.update(doc(db, 'voters', voter.id), {
    hasVoted: true,
    votedBoothId: booth.id,
    votedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Append strictly anonymized ballot (ZERO voter identity stored here)
  batch.set(doc(db, 'elections', election.id, 'ballots', ballotId), {
    electionId: election.id,
    candidateId: candidate.id,
    boothId: booth.id,
    constituency: voter.constituency,
    receiptHash,
    idempotencyKey: clampStr(idempotencyKey, 128),
    syncMode,
    castAt: serverTimestamp(),
  });

  // 3. Blind atomic increment on database-rule-locked sealed_tallies/official
  batch.update(doc(db, 'elections', election.id, 'sealed_tallies', 'official'), {
    [`counts.${candidate.id}`]: increment(1),
    totalTallied: increment(1),
    updatedAt: serverTimestamp(),
  });

  // 4. Increment public turnout totals (no candidate split revealed)
  batch.update(doc(db, 'elections', election.id), {
    totalVotesCast: increment(1),
    updatedAt: serverTimestamp(),
  });

  batch.update(doc(db, 'booths', booth.id), {
    votesCast: increment(1),
    lcdMessage: `VOTE OK ${receiptHash.slice(0, 6).toUpperCase()}`,
    lastHeartbeatAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    await appendAuditLog({
      category: syncMode === 'offline_reconciled' ? 'OFFLINE_SYNC' : 'ESP32',
      action: syncMode === 'offline_reconciled' ? 'OFFLINE_VOTE_COMMITTED' : 'ANONYMIZED_BALLOT_CAST',
      severity: 'info',
      actorRole,
      boothId: booth.id,
      electionId: election.id,
      summary: `Booth ${booth.boothCode} committed anonymized ballot receipt ${receiptHash.slice(0, 10).toUpperCase()} (${syncMode === 'offline_reconciled' ? 'reconciled from LittleFS offline queue' : 'real-time sync'}).`,
    });
    return { ballotId, receiptHash };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `elections/${election.id}/ballots/${ballotId}`);
  }
}

export async function updateBoothTelemetry(
  boothId: string,
  updates: Partial<{
    status: BoothStatus;
    syncState: BoothSyncState;
    wifiRssi: number;
    syncLatencyMs: number;
    batteryPct: number;
    pendingOfflineVotes: number;
    offlineQueueBytes: number;
    localConflictCount: number;
    tamperState: TamperState;
    lcdMessage: string;
    offlineSince: ReturnType<typeof serverTimestamp> | null;
    lastSyncAt: ReturnType<typeof serverTimestamp> | null;
  }>
) {
  const path = `booths/${boothId}`;
  try {
    await updateDoc(doc(db, 'booths', boothId), {
      ...updates,
      lastHeartbeatAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function reconcileOfflineQueueToFirestore(params: {
  election: Election;
  booth: EvmBooth;
  queuedVotes: OfflineQueuedVote[];
  voters: Voter[];
  candidates: Candidate[];
  actorRole: UserRole;
}): Promise<{
  committed: number;
  conflicts: number;
  duplicates: number;
  details: Array<{ localSeq: number; voterName: string; outcome: string; reason: string }>;
}> {
  const { election, booth, queuedVotes, voters, candidates, actorRole } = params;
  let committed = 0;
  let conflicts = 0;
  let duplicates = 0;
  const details: Array<{ localSeq: number; voterName: string; outcome: string; reason: string }> = [];

  await updateBoothTelemetry(booth.id, {
    syncState: 'syncing',
    lcdMessage: `SYNCING ${queuedVotes.length} QUEUED`,
  });

  const seenInBatch = new Set<string>();

  for (const item of queuedVotes) {
    const voter = voters.find((v) => v.id === item.voterDocId);
    const candidate = candidates.find((c) => c.id === item.candidateId);

    if (!voter || !candidate) {
      details.push({
        localSeq: item.localSeq,
        voterName: item.voterName,
        outcome: 'REJECTED',
        reason: 'Referenced voter or candidate no longer exists',
      });
      continue;
    }

    if (seenInBatch.has(item.voterDocId)) {
      duplicates++;
      details.push({
        localSeq: item.localSeq,
        voterName: item.voterName,
        outcome: 'DUPLICATE_IGNORED',
        reason: 'Already processed earlier in this offline queue batch',
      });
      continue;
    }

    if (voter.hasVoted) {
      conflicts++;
      details.push({
        localSeq: item.localSeq,
        voterName: item.voterName,
        outcome: 'CONFLICT_REJECTED_ALREADY_VOTED',
        reason: `Cross-booth double-vote detected: already voted at booth ${voter.votedBoothId || 'remote booth'} prior to Wi-Fi reconnect`,
      });
      await appendAuditLog({
        category: 'OFFLINE_SYNC',
        action: 'DOUBLE_VOTE_CONFLICT_REJECTED',
        severity: 'critical',
        actorRole,
        boothId: booth.id,
        electionId: election.id,
        summary: `Offline sync rejected queued vote #${item.localSeq} from ${booth.boothCode}: voter ${voter.voterIdNumber} had already voted at ${voter.votedBoothId || 'another booth'}. Tally unchanged.`,
        metadata: {
          localSeq: item.localSeq,
          idempotencyKey: item.idempotencyKey,
          conflictBoothId: voter.votedBoothId || 'unknown',
        },
      });
      continue;
    }

    await castAnonymizedVoteInFirestore({
      election,
      voter,
      candidate,
      booth,
      idempotencyKey: item.idempotencyKey,
      syncMode: 'offline_reconciled',
      actorRole,
    });
    seenInBatch.add(item.voterDocId);
    committed++;
    details.push({
      localSeq: item.localSeq,
      voterName: item.voterName,
      outcome: 'COMMITTED',
      reason: 'Anonymized ballot reconciled and voter marked globally as voted',
    });
  }

  await updateBoothTelemetry(booth.id, {
    status: booth.tamperState === 'nominal' ? 'online' : 'tampered',
    syncState: conflicts > 0 ? 'conflict_alert' : 'synced',
    pendingOfflineVotes: 0,
    offlineQueueBytes: 0,
    localConflictCount: (booth.localConflictCount || 0) + conflicts,
    offlineSince: null,
    lastSyncAt: serverTimestamp(),
    lcdMessage: conflicts > 0 ? `SYNC DONE (${conflicts} CONFL)` : 'ONLINE - SYNCED',
  });

  await appendAuditLog({
    category: 'OFFLINE_SYNC',
    action: 'OFFLINE_BATCH_RECONCILED',
    severity: conflicts > 0 ? 'warning' : 'info',
    actorRole,
    boothId: booth.id,
    electionId: election.id,
    summary: `Reconciled ${queuedVotes.length} offline queued vote(s) from ${booth.boothCode}: ${committed} committed, ${conflicts} cross-booth conflict(s) rejected, ${duplicates} duplicate(s) ignored.`,
  });

  return { committed, conflicts, duplicates, details };
}

export async function updateStaffMemberRole(
  targetUser: UserProfile,
  newRole: UserRole
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Authentication required');

  const batch = writeBatch(db);
  batch.update(doc(db, 'users', targetUser.uid), {
    role: newRole,
    updatedAt: serverTimestamp(),
  });

  if (newRole === 'admin') {
    batch.set(doc(db, 'admins', targetUser.uid), {
      uid: targetUser.uid,
      email: targetUser.email,
      grantedBy: currentUser.uid,
      createdAt: serverTimestamp(),
    });
  } else if (targetUser.uid !== currentUser.uid) {
    batch.delete(doc(db, 'admins', targetUser.uid));
  }

  try {
    await batch.commit();
    await appendAuditLog({
      category: 'ADMIN',
      action: 'STAFF_ROLE_UPDATED',
      severity: 'warning',
      actorRole: 'admin',
      summary: `Updated staff role for ${targetUser.email} to ${newRole === 'admin' ? 'Election Administrator' : 'Polling Officer'}.`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${targetUser.uid}`);
  }
}

/**
 * One-Click Sample Election Seed for immediate end-to-end testing of all Smart Vote flows
 */
export async function seedSampleElection(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Must be signed in as Election Administrator to seed sample data.');

  const electionId = makeId('el_sample');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  const end = new Date(now.getTime() + 6 * 3600 * 1000).toISOString();
  const constituencies = ['North District', 'Harbor Ward'];

  const candSpecs = [
    {
      id: makeId('cand'),
      name: 'Elena Vance',
      party: 'Civic Alliance',
      constituency: 'North District',
      ballotNumber: 1,
      symbolUrl: PARTY_EMBLEM_PRESETS[0].url,
      accentColor: PARTY_EMBLEM_PRESETS[0].color,
      seedVotes: 2,
    },
    {
      id: makeId('cand'),
      name: 'Marcus Chen',
      party: 'Green Future',
      constituency: 'North District',
      ballotNumber: 2,
      symbolUrl: PARTY_EMBLEM_PRESETS[1].url,
      accentColor: PARTY_EMBLEM_PRESETS[1].color,
      seedVotes: 1,
    },
    {
      id: makeId('cand'),
      name: 'Priya Nair',
      party: 'Meridian Reform',
      constituency: 'Harbor Ward',
      ballotNumber: 1,
      symbolUrl: PARTY_EMBLEM_PRESETS[2].url,
      accentColor: PARTY_EMBLEM_PRESETS[2].color,
      seedVotes: 1,
    },
    {
      id: makeId('cand'),
      name: 'David Okafor',
      party: 'Unity Progress',
      constituency: 'Harbor Ward',
      ballotNumber: 2,
      symbolUrl: PARTY_EMBLEM_PRESETS[3].url,
      accentColor: PARTY_EMBLEM_PRESETS[3].color,
      seedVotes: 1,
    },
  ];

  const boothSpecs = [
    {
      id: makeId('booth'),
      boothCode: 'EVM-N01',
      name: 'North Civic Hall — Station 1',
      constituency: 'North District',
      status: 'online' as BoothStatus,
      syncState: 'synced' as BoothSyncState,
      wifiRssi: -49,
      syncLatencyMs: 31,
      batteryPct: 96,
      votesCast: 2,
      pendingOfflineVotes: 0,
      offlineQueueBytes: 0,
      tamperState: 'nominal' as TamperState,
      lcdMessage: 'READY - PLACE FINGER',
    },
    {
      id: makeId('booth'),
      boothCode: 'EVM-N02',
      name: 'North Tech Library — Station 2',
      constituency: 'North District',
      status: 'degraded' as BoothStatus,
      syncState: 'synced' as BoothSyncState,
      wifiRssi: -84,
      syncLatencyMs: 492,
      batteryPct: 78,
      votesCast: 1,
      pendingOfflineVotes: 0,
      offlineQueueBytes: 0,
      tamperState: 'nominal' as TamperState,
      lcdMessage: 'WEAK WIFI - READY',
    },
    {
      id: makeId('booth'),
      boothCode: 'EVM-H01',
      name: 'Harbor Pavilion — Station 1',
      constituency: 'Harbor Ward',
      status: 'online' as BoothStatus,
      syncState: 'synced' as BoothSyncState,
      wifiRssi: -55,
      syncLatencyMs: 44,
      batteryPct: 91,
      votesCast: 2,
      pendingOfflineVotes: 0,
      offlineQueueBytes: 0,
      tamperState: 'nominal' as TamperState,
      lcdMessage: 'READY - PLACE FINGER',
    },
    {
      id: makeId('booth'),
      boothCode: 'EVM-H02',
      name: 'Harbor Ferry Terminal — Station 2',
      constituency: 'Harbor Ward',
      status: 'offline' as BoothStatus,
      syncState: 'offline_queuing' as BoothSyncState,
      wifiRssi: -98,
      syncLatencyMs: 0,
      batteryPct: 68,
      votesCast: 0,
      pendingOfflineVotes: 2,
      offlineQueueBytes: 640,
      tamperState: 'nominal' as TamperState,
      lcdMessage: 'OFFLINE QUEUE (2)',
    },
  ];

  const voterSpecs = [
    { name: 'Aarav Kulkarni', vid: 'SV-ND-1001', ct: 'North District', status: 'enrolled', fp: 'FP-101', voted: true, boothIdx: 0 },
    { name: 'Sofia Lindqvist', vid: 'SV-ND-1002', ct: 'North District', status: 'enrolled', fp: 'FP-102', voted: true, boothIdx: 0 },
    { name: 'Liam Gallagher', vid: 'SV-ND-1003', ct: 'North District', status: 'enrolled', fp: 'FP-103', voted: true, boothIdx: 1 },
    { name: 'Nadia Al-Mansoor', vid: 'SV-ND-1004', ct: 'North District', status: 'enrolled', fp: 'FP-104', voted: false, boothIdx: 0 },
    { name: 'Kenji Takahashi', vid: 'SV-ND-1005', ct: 'North District', status: 'enrolled', fp: 'FP-105', voted: false, boothIdx: 0 },
    { name: 'Clara Morales', vid: 'SV-ND-1006', ct: 'North District', status: 'pending', fp: null, voted: false, boothIdx: null },
    { name: 'Samuel Boateng', vid: 'SV-HW-2001', ct: 'Harbor Ward', status: 'enrolled', fp: 'FP-201', voted: true, boothIdx: 2 },
    { name: 'Hannah Novak', vid: 'SV-HW-2002', ct: 'Harbor Ward', status: 'enrolled', fp: 'FP-202', voted: true, boothIdx: 2 },
    { name: 'Rohan Deshmukh', vid: 'SV-HW-2003', ct: 'Harbor Ward', status: 'enrolled', fp: 'FP-203', voted: false, boothIdx: 2 },
    { name: 'Grace Osei', vid: 'SV-HW-2004', ct: 'Harbor Ward', status: 'enrolled', fp: 'FP-204', voted: false, boothIdx: 2 },
    { name: 'Daniel Kowalski', vid: 'SV-HW-2005', ct: 'Harbor Ward', status: 'enrolled', fp: 'FP-205', voted: false, boothIdx: 3 },
    { name: 'Maya Subramanian', vid: 'SV-HW-2006', ct: 'Harbor Ward', status: 'pending', fp: null, voted: false, boothIdx: null },
  ] as const;

  const ballotHash = await computeSha256Hex(
    JSON.stringify(candSpecs.map((c) => ({ id: c.id, n: c.ballotNumber, nm: c.name, p: c.party })))
  );

  const batch = writeBatch(db);

  // 1. Election document
  batch.set(doc(db, 'elections', electionId), {
    title: '2026 Metropolitan Civic General Election',
    description:
      'Live multi-constituency municipal election utilizing ESP32 R307/AS608 optical biometric terminals with database-enforced result sealing.',
    constituencies,
    startTime: start,
    endTime: end,
    status: 'active',
    resultsUnsealed: false,
    ballotVersion: 2,
    ballotHash,
    totalRegisteredVoters: voterSpecs.length,
    totalVotesCast: 5,
    validationPassed: true,
    createdBy: user.uid,
    lastPushedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Candidates
  const countsMap: Record<string, number> = {};
  for (const c of candSpecs) {
    countsMap[c.id] = c.seedVotes;
    batch.set(doc(db, 'elections', electionId, 'candidates', c.id), {
      electionId,
      name: c.name,
      party: c.party,
      constituency: c.constituency,
      ballotNumber: c.ballotNumber,
      symbolUrl: c.symbolUrl,
      accentColor: c.accentColor,
      createdAt: serverTimestamp(),
    });
  }

  // 3. Sealed tally document (unreadable via rules until election closes & admin unseals!)
  batch.set(doc(db, 'elections', electionId, 'sealed_tallies', 'official'), {
    electionId,
    counts: countsMap,
    totalTallied: 5,
    updatedAt: serverTimestamp(),
  });

  // 4. Anonymized initial ballots
  let ballotIdx = 0;
  for (const c of candSpecs) {
    for (let i = 0; i < c.seedVotes; i++) {
      const bid = makeId(`bal${ballotIdx++}`);
      const boothId = c.constituency === 'North District' ? boothSpecs[0].id : boothSpecs[2].id;
      const receiptHash = (await computeSha256Hex(`${electionId}:${c.id}:${bid}`)).slice(0, 24);
      batch.set(doc(db, 'elections', electionId, 'ballots', bid), {
        electionId,
        candidateId: c.id,
        boothId,
        constituency: c.constituency,
        receiptHash,
        idempotencyKey: `idem_seed_${bid}`,
        syncMode: 'online',
        castAt: serverTimestamp(),
      });
    }
  }

  // 5. ESP32 Booths
  for (const b of boothSpecs) {
    const demoApiKey = `sv_esp32_${b.boothCode.toLowerCase().replace(/[^a-z0-9]/g, '')}_demo_key`;
    const apiKeyHash = await computeSha256Hex(demoApiKey);
    batch.set(doc(db, 'booths', b.id), {
      boothCode: b.boothCode,
      name: b.name,
      constituency: b.constituency,
      electionId,
      apiKeyPrefix: demoApiKey.slice(0, 14),
      apiKeyHash,
      status: b.status,
      syncState: b.syncState,
      wifiRssi: b.wifiRssi,
      syncLatencyMs: b.syncLatencyMs,
      batteryPct: b.batteryPct,
      firmwareVersion: '2.4.1-esp32',
      ballotVersion: 2,
      votesCast: b.votesCast,
      pendingOfflineVotes: b.pendingOfflineVotes,
      offlineQueueBytes: b.offlineQueueBytes,
      localConflictCount: 0,
      tamperState: b.tamperState,
      lcdMessage: b.lcdMessage,
      pendingCommand: null,
      lastHeartbeatAt: serverTimestamp(),
      offlineSince: b.status === 'offline' ? serverTimestamp() : null,
      lastSyncAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 6. Voters
  for (const v of voterSpecs) {
    const vidDoc = makeId('voter');
    const boothId = v.boothIdx !== null ? boothSpecs[v.boothIdx].id : null;
    batch.set(doc(db, 'voters', vidDoc), {
      fullName: v.name,
      voterIdNumber: v.vid,
      constituency: v.ct,
      electionId,
      enrollmentStatus: v.status,
      fingerprintTemplateId: v.fp,
      enrolledBoothId: boothId,
      hasVoted: v.voted,
      votedBoothId: v.voted ? boothId : null,
      votedAt: v.voted ? serverTimestamp() : null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 7. Initial immutable audit logs
  const seedLogs: Array<{
    category: AuditCategory;
    action: string;
    severity: AuditSeverity;
    actorRole: 'admin' | 'officer' | 'esp32';
    boothId?: string;
    summary: string;
  }> = [
    {
      category: 'ADMIN',
      action: 'PRE_ELECTION_VALIDATION_PASSED',
      severity: 'info',
      actorRole: 'admin',
      summary: 'Pre-election configuration validation passed all 7 checks; ballot v2 signed and pushed to 4 ESP32 terminals.',
    },
    {
      category: 'ESP32',
      action: 'BOOTH_HEARTBEAT_DEGRADED',
      severity: 'warning',
      actorRole: 'esp32',
      boothId: boothSpecs[1].id,
      summary: 'EVM-N02 reported degraded Wi-Fi RSSI (-84 dBm, 492 ms latency). Automatic retry buffer standing by.',
    },
    {
      category: 'OFFLINE_SYNC',
      action: 'OFFLINE_MODE_ENGAGED',
      severity: 'warning',
      actorRole: 'esp32',
      boothId: boothSpecs[3].id,
      summary: 'EVM-H02 lost Wi-Fi uplink; local LittleFS encrypted ring-queue active (2 pending ballots, 640 B flash used).',
    },
  ];

  for (const entry of seedLogs) {
    const logId = makeId('log');
    batch.set(doc(db, 'audit_logs', logId), {
      category: entry.category,
      action: entry.action,
      severity: entry.severity,
      actorUid: user.uid,
      actorEmail: clampStr(user.email || 'admin@smartvote.local', 160),
      actorRole: entry.actorRole,
      ...(entry.boothId ? { boothId: entry.boothId } : {}),
      electionId,
      summary: entry.summary,
      createdAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    return electionId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `elections/${electionId}`);
  }
}

async function commitBatchedDeletes(refs: DocumentReference[]): Promise<number> {
  const CHUNK_SIZE = 400;
  let deleted = 0;
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const slice = refs.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const ref of slice) {
      batch.delete(ref);
    }
    await batch.commit();
    deleted += slice.length;
  }
  return deleted;
}

/**
 * Permanently deletes an election, all of its Firestore subcollections (candidates,
 * ballots, sealed_tallies/official) and associated booths/voters, then purges
 * Express gateway server memory storage.
 */
export async function deleteElectionAndClearStorage(election: Election): Promise<{
  deletedCandidates: number;
  deletedBallots: number;
  deletedBooths: number;
  deletedVoters: number;
}> {
  const user = auth.currentUser;
  if (!user) throw new Error('Election Administrator authentication required.');

  const electionId = election.id;

  try {
    // 1. Delete parent election doc first (unlocks orphaned ballot subcollection cleanup in rules)
    await deleteDoc(doc(db, 'elections', electionId));

    // 2. Delete sealed tally accumulator directly
    try {
      await deleteDoc(doc(db, 'elections', electionId, 'sealed_tallies', 'official'));
    } catch {
      // May not exist if previously cleaned
    }

    // 3. Gather all subcollection & linked docs to clear Firestore storage
    const [candSnap, ballotSnap, boothSnap, voterSnap] = await Promise.all([
      getDocs(collection(db, 'elections', electionId, 'candidates')),
      getDocs(collection(db, 'elections', electionId, 'ballots')),
      getDocs(query(collection(db, 'booths'), where('electionId', '==', electionId))),
      getDocs(query(collection(db, 'voters'), where('electionId', '==', electionId))),
    ]);

    const refsToDelete: DocumentReference[] = [
      ...candSnap.docs.map((d) => d.ref),
      ...ballotSnap.docs.map((d) => d.ref),
      ...boothSnap.docs.map((d) => d.ref),
      ...voterSnap.docs.map((d) => d.ref),
    ];

    if (refsToDelete.length > 0) {
      await commitBatchedDeletes(refsToDelete);
    }

    // 4. Clear Express server gateway memory storage (ballots, booths, voters, idempotency keys)
    await fetch('/api/gateway/purge-election', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ electionId }),
    }).catch(() => undefined);

    // 5. Record immutable audit entry
    await appendAuditLog({
      category: 'ADMIN',
      action: 'ELECTION_DELETED_STORAGE_CLEARED',
      severity: 'warning',
      actorRole: 'admin',
      electionId,
      summary: `Deleted election "${clampStr(election.title, 80)}" and purged ${candSnap.size} candidate(s), ${ballotSnap.size} ballot(s), ${boothSnap.size} booth(s), ${voterSnap.size} voter(s), and Express server gateway cache.`,
      metadata: {
        deletedCandidates: candSnap.size,
        deletedBallots: ballotSnap.size,
        deletedBooths: boothSnap.size,
        deletedVoters: voterSnap.size,
      },
    });

    return {
      deletedCandidates: candSnap.size,
      deletedBallots: ballotSnap.size,
      deletedBooths: boothSnap.size,
      deletedVoters: voterSnap.size,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `elections/${electionId}`);
  }
}

/**
 * Deletes all previous (closed or draft) elections in one pass and clears
 * both Firestore records and Express server gateway memory storage.
 */
export async function purgePreviousElectionsAndServerStorage(
  previousElections: Election[]
): Promise<{
  deletedElections: number;
  totalDocsPurged: number;
}> {
  let deletedElections = 0;
  let totalDocsPurged = 0;

  for (const el of previousElections) {
    const res = await deleteElectionAndClearStorage(el);
    deletedElections += 1;
    totalDocsPurged +=
      1 +
      res.deletedCandidates +
      res.deletedBallots +
      res.deletedBooths +
      res.deletedVoters;
  }

  return { deletedElections, totalDocsPurged };
}

