import type { Timestamp } from 'firebase/firestore';

export type UserRole = 'admin' | 'officer';
export type ElectionStatus = 'draft' | 'active' | 'closed';
export type BoothStatus = 'online' | 'degraded' | 'offline' | 'tampered';
export type BoothSyncState = 'synced' | 'offline_queuing' | 'syncing' | 'conflict_alert';
export type TamperState = 'nominal' | 'enclosure_open' | 'sensor_fault' | 'voltage_anomaly';
export type EnrollmentStatus = 'pending' | 'enrolling' | 'enrolled';
export type AuditCategory = 'ADMIN' | 'OFFICER' | 'ESP32' | 'SECURITY' | 'UNSEAL' | 'OFFLINE_SYNC';
export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  assignedConstituency?: string;
  photoUrl?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Election {
  id: string;
  title: string;
  description: string;
  constituencies: string[];
  startTime: string;
  endTime: string;
  status: ElectionStatus;
  resultsUnsealed: boolean;
  ballotVersion: number;
  ballotHash: string;
  totalRegisteredVoters: number;
  totalVotesCast: number;
  validationPassed?: boolean;
  createdBy: string;
  unsealedBy?: string;
  unsealedByEmail?: string;
  unsealedAt?: Timestamp;
  closedAt?: Timestamp;
  lastPushedAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Candidate {
  id: string;
  electionId: string;
  name: string;
  party: string;
  constituency: string;
  ballotNumber: number;
  symbolUrl: string;
  accentColor: string;
  createdAt?: Timestamp;
}

export interface SealedTally {
  electionId: string;
  counts: Record<string, number>;
  totalTallied: number;
  updatedAt?: Timestamp;
}

export interface BoothCommand {
  commandId: string;
  type: 'ENROLL_FINGERPRINT' | 'SYNC_BALLOT' | 'LOCK_BOOTH' | 'UNLOCK_BOOTH';
  issuedAt: string;
  voterDocId?: string;
  voterName?: string;
  ballotVersion?: number;
  ballotHash?: string;
}

export interface EvmBooth {
  id: string;
  boothCode: string;
  name: string;
  constituency: string;
  electionId: string;
  apiKeyPrefix: string;
  apiKeyHash: string;
  status: BoothStatus;
  syncState: BoothSyncState;
  wifiRssi: number;
  syncLatencyMs: number;
  batteryPct: number;
  firmwareVersion: string;
  ballotVersion: number;
  votesCast: number;
  pendingOfflineVotes: number;
  offlineQueueBytes: number;
  localConflictCount?: number;
  tamperState: TamperState;
  lcdMessage: string;
  pendingCommand?: BoothCommand | null;
  lastHeartbeatAt?: Timestamp;
  offlineSince?: Timestamp | null;
  lastSyncAt?: Timestamp | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Voter {
  id: string;
  fullName: string;
  voterIdNumber: string;
  constituency: string;
  electionId: string;
  enrollmentStatus: EnrollmentStatus;
  fingerprintTemplateId?: string | null;
  enrolledBoothId?: string | null;
  hasVoted: boolean;
  votedBoothId?: string | null;
  votedAt?: Timestamp | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AuditLog {
  id: string;
  category: AuditCategory;
  action: string;
  severity: AuditSeverity;
  actorUid: string;
  actorEmail: string;
  actorRole: 'admin' | 'officer' | 'esp32';
  boothId?: string | null;
  electionId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
}

export interface OfflineQueuedVote {
  localSeq: number;
  idempotencyKey: string;
  voterDocId: string;
  voterName: string;
  fingerprintTemplateId: string;
  candidateId: string;
  candidateName: string;
  constituency: string;
  capturedAt: string;
  payloadMac: string;
  byteSize: number;
}

export interface ValidationCheckResult {
  id: string;
  category: 'schedule' | 'candidates' | 'ballot' | 'hardware';
  title: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  blocking: boolean;
}

export interface PreElectionValidationReport {
  readyToDeploy: boolean;
  blockingFailures: number;
  warnings: number;
  passedChecks: number;
  ballotPayloadBytes: number;
  computedBallotHash: string;
  checks: ValidationCheckResult[];
}
