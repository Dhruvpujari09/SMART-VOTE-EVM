import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ============================================================================
// Authoritative Real-Time ESP32 Hardware Gateway State (Synced with Firestore)
// ============================================================================
interface GatewayBooth {
  boothId: string;
  boothCode: string;
  electionId: string;
  constituency: string;
  apiKeyHash: string;
  apiKeyPlain?: string; // Available for demo/provisioned booths to test directly in Workbench
  status: 'online' | 'degraded' | 'offline' | 'tampered';
  syncState: 'synced' | 'offline_queuing' | 'syncing' | 'conflict_alert';
  wifiRssi: number;
  syncLatencyMs: number;
  batteryPct: number;
  firmwareVersion: string;
  ballotVersion: number;
  pendingOfflineVotes: number;
  offlineQueueBytes: number;
  tamperState: 'nominal' | 'enclosure_open' | 'sensor_fault' | 'voltage_anomaly';
  lcdMessage: string;
  lastHeartbeatIso: string;
  pendingCommand: Record<string, unknown> | null;
}

interface GatewayBallotManifest {
  electionId: string;
  title: string;
  status: 'draft' | 'active' | 'closed';
  ballotVersion: number;
  ballotHash: string;
  candidates: Array<{
    id: string;
    ballotNumber: number;
    name: string;
    party: string;
    constituency: string;
  }>;
}

interface GatewayVoterEntry {
  voterDocId: string;
  electionId: string;
  constituency: string;
  fingerprintTemplateId: string | null;
  hasVoted: boolean;
  votedBoothId: string | null;
  votedAtIso: string | null;
}

const gatewayBooths = new Map<string, GatewayBooth>();
const gatewayBallots = new Map<string, GatewayBallotManifest>();
const gatewayVoters = new Map<string, GatewayVoterEntry>();
const committedIdempotencyKeys = new Set<string>();
const esp32Sockets = new Map<string, WebSocket>();
const dashboardSockets = new Set<WebSocket>();

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function broadcastToDashboards(eventType: string, payload: Record<string, unknown>) {
  const frame = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    payload,
  });
  for (const client of dashboardSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frame);
    }
  }
}

function sendToEsp32(boothId: string, eventType: string, payload: Record<string, unknown>): boolean {
  const socket = esp32Sockets.get(boothId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        payload,
      })
    );
    return true;
  }
  return false;
}

// ============================================================================
// ESP32 Device Authentication Middleware (X-Device-ID + X-Device-API-Key)
// ============================================================================
function authenticateEsp32(req: Request, res: Response, next: NextFunction) {
  const deviceId = String(req.header('x-device-id') || '').trim();
  const apiKey = String(req.header('x-device-api-key') || '').trim();

  if (!deviceId || !apiKey) {
    res.status(401).json({
      error: 'MISSING_DEVICE_CREDENTIALS',
      message: 'Both X-Device-ID and X-Device-API-Key headers are required.',
    });
    return;
  }

  const booth = gatewayBooths.get(deviceId);
  if (!booth) {
    res.status(403).json({
      error: 'UNKNOWN_DEVICE',
      message: `Device ${deviceId} is not registered in the active gateway registry.`,
    });
    return;
  }

  const incomingHash = sha256Hex(apiKey);
  const hashMatches =
    incomingHash === booth.apiKeyHash ||
    apiKey === booth.apiKeyHash ||
    (booth.apiKeyPlain && apiKey === booth.apiKeyPlain);

  if (!hashMatches) {
    res.status(403).json({
      error: 'INVALID_API_KEY',
      message: 'Device API key verification failed.',
    });
    return;
  }

  (req as Request & { booth: GatewayBooth }).booth = booth;
  next();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Health & Gateway status
  app.get('/api/health', (_req, res) => {
    res.json({
      service: 'smart-vote-gateway',
      status: 'ok',
      registeredBooths: gatewayBooths.size,
      connectedEsp32Sockets: esp32Sockets.size,
      connectedDashboards: dashboardSockets.size,
      timestamp: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // Dashboard -> Gateway Synchronization Bridge (Keeps live MCU auth in sync)
  // ==========================================================================
  app.post('/api/gateway/sync-state', (req, res) => {
    const { booths, ballots, voters, authoritative = false } = req.body || {};

    if (Array.isArray(booths)) {
      const incomingBoothIds = new Set<string>();
      for (const b of booths) {
        if (!b || !b.boothId) continue;
        const id = String(b.boothId);
        incomingBoothIds.add(id);
        const existing = gatewayBooths.get(id);
        gatewayBooths.set(id, {
          boothId: id,
          boothCode: String(b.boothCode || id),
          electionId: String(b.electionId || ''),
          constituency: String(b.constituency || ''),
          apiKeyHash: String(b.apiKeyHash || existing?.apiKeyHash || ''),
          apiKeyPlain: b.apiKeyPlain || existing?.apiKeyPlain,
          status: b.status || existing?.status || 'online',
          syncState: b.syncState || existing?.syncState || 'synced',
          wifiRssi: typeof b.wifiRssi === 'number' ? b.wifiRssi : -55,
          syncLatencyMs: typeof b.syncLatencyMs === 'number' ? b.syncLatencyMs : 38,
          batteryPct: typeof b.batteryPct === 'number' ? b.batteryPct : 95,
          firmwareVersion: String(b.firmwareVersion || '2.4.1-esp32'),
          ballotVersion: typeof b.ballotVersion === 'number' ? b.ballotVersion : 1,
          pendingOfflineVotes: typeof b.pendingOfflineVotes === 'number' ? b.pendingOfflineVotes : 0,
          offlineQueueBytes: typeof b.offlineQueueBytes === 'number' ? b.offlineQueueBytes : 0,
          tamperState: b.tamperState || 'nominal',
          lcdMessage: String(b.lcdMessage || 'READY - PLACE FINGER'),
          lastHeartbeatIso: b.lastHeartbeatIso || new Date().toISOString(),
          pendingCommand: b.pendingCommand !== undefined ? b.pendingCommand : existing?.pendingCommand ?? null,
        });
      }
      if (authoritative) {
        for (const existingId of Array.from(gatewayBooths.keys())) {
          if (!incomingBoothIds.has(existingId)) {
            gatewayBooths.delete(existingId);
          }
        }
      }
    }

    if (Array.isArray(ballots)) {
      const incomingElectionIds = new Set<string>();
      for (const m of ballots) {
        if (!m || !m.electionId) continue;
        const eid = String(m.electionId);
        incomingElectionIds.add(eid);
        gatewayBallots.set(eid, m);
      }
      if (authoritative && ballots.length === 0) {
        gatewayBallots.clear();
      } else if (authoritative) {
        for (const existingEid of Array.from(gatewayBallots.keys())) {
          if (!incomingElectionIds.has(existingEid)) {
            gatewayBallots.delete(existingEid);
          }
        }
      }
    }

    if (Array.isArray(voters)) {
      const incomingVoterIds = new Set<string>();
      for (const v of voters) {
        if (!v || !v.voterDocId) continue;
        const vid = String(v.voterDocId);
        incomingVoterIds.add(vid);
        gatewayVoters.set(vid, {
          voterDocId: vid,
          electionId: String(v.electionId || ''),
          constituency: String(v.constituency || ''),
          fingerprintTemplateId: v.fingerprintTemplateId ?? null,
          hasVoted: Boolean(v.hasVoted),
          votedBoothId: v.votedBoothId ?? null,
          votedAtIso: v.votedAtIso ?? null,
        });
      }
      if (authoritative) {
        for (const existingVid of Array.from(gatewayVoters.keys())) {
          if (!incomingVoterIds.has(existingVid)) {
            gatewayVoters.delete(existingVid);
          }
        }
      }
    }

    res.json({
      synced: true,
      booths: gatewayBooths.size,
      ballots: gatewayBallots.size,
      voters: gatewayVoters.size,
    });
  });

  // Purge deleted election(s) and reclaim Express gateway memory storage
  app.post('/api/gateway/purge-election', (req, res) => {
    const body = req.body || {};
    const ids: string[] = Array.isArray(body.electionIds)
      ? body.electionIds.map(String).filter(Boolean)
      : body.electionId
        ? [String(body.electionId)]
        : [];

    if (ids.length === 0) {
      res.status(400).json({ error: 'MISSING_ELECTION_ID' });
      return;
    }

    const idSet = new Set(ids);
    let purgedBallots = 0;
    let purgedBooths = 0;
    let purgedVoters = 0;

    for (const eid of idSet) {
      if (gatewayBallots.delete(eid)) purgedBallots++;
    }

    for (const [boothId, booth] of Array.from(gatewayBooths.entries())) {
      if (idSet.has(booth.electionId)) {
        gatewayBooths.delete(boothId);
        const sock = esp32Sockets.get(boothId);
        if (sock) {
          try {
            sock.close(1000, 'ELECTION_PURGED');
          } catch {
            // ignore close error
          }
          esp32Sockets.delete(boothId);
        }
        purgedBooths++;
      }
    }

    for (const [voterId, voter] of Array.from(gatewayVoters.entries())) {
      if (idSet.has(voter.electionId)) {
        gatewayVoters.delete(voterId);
        purgedVoters++;
      }
    }

    const clearedIdempotencyKeys = committedIdempotencyKeys.size;
    committedIdempotencyKeys.clear();

    broadcastToDashboards('gateway:storage_cleared', {
      electionIds: ids,
      purgedBallots,
      purgedBooths,
      purgedVoters,
      clearedIdempotencyKeys,
    });

    res.json({
      purged: true,
      electionIds: ids,
      purgedBallots,
      purgedBooths,
      purgedVoters,
      clearedIdempotencyKeys,
    });
  });

  // Dashboard pushes remote command (ENROLL_FINGERPRINT | SYNC_BALLOT | LOCK_BOOTH) to target ESP32
  app.post('/api/gateway/dispatch-command', (req, res) => {
    const { boothId, command } = req.body || {};
    if (!boothId || !command || !command.type) {
      res.status(400).json({ error: 'INVALID_COMMAND_PAYLOAD' });
      return;
    }

    const booth = gatewayBooths.get(boothId);
    const wrappedCommand = {
      commandId: `cmd_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      issuedAt: new Date().toISOString(),
      ...command,
    };

    if (booth) {
      booth.pendingCommand = wrappedCommand;
    }

    const pushedRealtime = sendToEsp32(boothId, 'esp32:command', wrappedCommand);
    broadcastToDashboards('command:dispatched', {
      boothId,
      command: wrappedCommand,
      delivery: pushedRealtime ? 'websocket_instant' : 'queued_for_heartbeat',
    });

    res.json({
      accepted: true,
      command: wrappedCommand,
      delivery: pushedRealtime ? 'websocket_instant' : 'queued_for_heartbeat',
    });
  });

  // ==========================================================================
  // Lightweight JSON REST API for ESP32 Microcontrollers (Arduino / ESP-IDF)
  // ==========================================================================

  // 1. Heartbeat & Command Polling
  app.post('/api/esp32/heartbeat', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const {
      rssi = -54,
      latencyMs = 42,
      batteryPct = 96,
      firmwareVersion = booth.firmwareVersion,
      ballotVersion = booth.ballotVersion,
      tamperTriggered = false,
      tamperState = tamperTriggered ? 'enclosure_open' : 'nominal',
      pendingOfflineVotes = 0,
      offlineQueueBytes = 0,
      lcdMessage = 'READY - PLACE FINGER',
    } = req.body || {};

    booth.wifiRssi = Math.max(-120, Math.min(0, Math.round(Number(rssi))));
    booth.syncLatencyMs = Math.max(0, Math.min(60000, Math.round(Number(latencyMs))));
    booth.batteryPct = Math.max(0, Math.min(100, Math.round(Number(batteryPct))));
    booth.firmwareVersion = String(firmwareVersion).slice(0, 32);
    booth.ballotVersion = Math.max(0, Math.round(Number(ballotVersion)));
    booth.pendingOfflineVotes = Math.max(0, Math.round(Number(pendingOfflineVotes)));
    booth.offlineQueueBytes = Math.max(0, Math.round(Number(offlineQueueBytes)));
    booth.tamperState = tamperState;
    booth.lcdMessage = String(lcdMessage).slice(0, 80);
    booth.lastHeartbeatIso = new Date().toISOString();

    if (tamperState !== 'nominal') {
      booth.status = 'tampered';
    } else if (booth.wifiRssi < -82 || booth.syncLatencyMs > 450) {
      booth.status = 'degraded';
    } else {
      booth.status = 'online';
    }
    booth.syncState = booth.pendingOfflineVotes > 0 ? 'syncing' : 'synced';

    const queuedCommand = booth.pendingCommand;
    booth.pendingCommand = null;

    const ballot = gatewayBallots.get(booth.electionId);
    const ballotSyncRequired = Boolean(ballot && ballot.ballotVersion > booth.ballotVersion);

    broadcastToDashboards('esp32:heartbeat', {
      boothId: booth.boothId,
      boothCode: booth.boothCode,
      status: booth.status,
      syncState: booth.syncState,
      wifiRssi: booth.wifiRssi,
      syncLatencyMs: booth.syncLatencyMs,
      batteryPct: booth.batteryPct,
      firmwareVersion: booth.firmwareVersion,
      ballotVersion: booth.ballotVersion,
      tamperState: booth.tamperState,
      pendingOfflineVotes: booth.pendingOfflineVotes,
      offlineQueueBytes: booth.offlineQueueBytes,
      lcdMessage: booth.lcdMessage,
      lastHeartbeatIso: booth.lastHeartbeatIso,
    });

    res.json({
      ack: true,
      serverTime: new Date().toISOString(),
      electionStatus: ballot?.status || 'active',
      latestBallotVersion: ballot?.ballotVersion ?? booth.ballotVersion,
      ballotSyncRequired,
      command: queuedCommand,
    });
  });

  // 2. Compact Ballot Manifest Download for ESP32 ArduinoJson
  app.get('/api/esp32/ballot', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const electionId = String(req.query.electionId || booth.electionId);
    const ballot = gatewayBallots.get(electionId);

    if (!ballot) {
      res.status(404).json({ error: 'BALLOT_NOT_FOUND', electionId });
      return;
    }

    const constituencyCandidates = ballot.candidates
      .filter((c) => !booth.constituency || c.constituency === booth.constituency)
      .sort((a, b) => a.ballotNumber - b.ballotNumber);

    const payload = {
      electionId: ballot.electionId,
      title: ballot.title,
      status: ballot.status,
      constituency: booth.constituency,
      ballotVersion: ballot.ballotVersion,
      ballotHash: ballot.ballotHash,
      candidateCount: constituencyCandidates.length,
      candidates: constituencyCandidates.map((c) => ({
        id: c.id,
        num: c.ballotNumber,
        name: c.name,
        party: c.party,
      })),
    };

    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    booth.ballotVersion = ballot.ballotVersion;

    broadcastToDashboards('esp32:ballot_synced', {
      boothId: booth.boothId,
      ballotVersion: ballot.ballotVersion,
      ballotHash: ballot.ballotHash,
      payloadBytes,
    });

    res.json({ ...payload, payloadBytes });
  });

  // 3. Remote Fingerprint Enrollment Completion (Rejects raw biometric data!)
  app.post('/api/esp32/enroll-complete', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const body = req.body || {};

    // Privacy invariant: strictly reject any raw fingerprint image / minutiae payloads
    if ('rawImage' in body || 'fingerprintImage' in body || 'minutiae' in body || 'biometricBlob' in body) {
      res.status(400).json({
        error: 'RAW_BIOMETRICS_PROHIBITED',
        message: 'Raw fingerprint imagery or minutiae must never leave the ESP32 sensor flash. Send only opaque fingerprintTemplateId.',
      });
      return;
    }

    const { commandId, voterDocId, fingerprintTemplateId, qualityScore = 94 } = body;
    if (!voterDocId || !fingerprintTemplateId) {
      res.status(400).json({ error: 'MISSING_ENROLLMENT_FIELDS' });
      return;
    }

    const voter = gatewayVoters.get(voterDocId);
    if (voter) {
      voter.fingerprintTemplateId = String(fingerprintTemplateId).slice(0, 40);
    }

    broadcastToDashboards('esp32:enroll_complete', {
      commandId: commandId || null,
      boothId: booth.boothId,
      voterDocId: String(voterDocId),
      fingerprintTemplateId: String(fingerprintTemplateId).slice(0, 40),
      qualityScore: Number(qualityScore),
    });

    res.json({
      stored: true,
      voterDocId,
      fingerprintTemplateId,
      rawBiometricsDiscarded: true,
    });
  });

  // 4. Real-Time Voter Eligibility Verification (Anti-Duplicate Pre-Check)
  app.post('/api/esp32/verify-voter', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const { electionId = booth.electionId, fingerprintTemplateId } = req.body || {};

    if (!fingerprintTemplateId) {
      res.status(400).json({ error: 'MISSING_TEMPLATE_ID' });
      return;
    }

    const ballot = gatewayBallots.get(electionId);
    if (ballot && ballot.status !== 'active') {
      res.status(409).json({
        eligible: false,
        reason: 'ELECTION_NOT_ACTIVE',
        lcdLine1: 'POLLS NOT ACTIVE',
        lcdLine2: `STATE: ${ballot.status.toUpperCase()}`,
      });
      return;
    }

    let matchedVoter: GatewayVoterEntry | undefined;
    for (const v of gatewayVoters.values()) {
      if (v.electionId === electionId && v.fingerprintTemplateId === fingerprintTemplateId) {
        matchedVoter = v;
        break;
      }
    }

    if (!matchedVoter) {
      res.status(404).json({
        eligible: false,
        reason: 'TEMPLATE_NOT_REGISTERED',
        lcdLine1: 'ID NOT FOUND',
        lcdLine2: 'CONTACT OFFICER',
      });
      return;
    }

    if (matchedVoter.hasVoted) {
      broadcastToDashboards('security:duplicate_attempt', {
        boothId: booth.boothId,
        electionId,
        voterDocId: matchedVoter.voterDocId,
        originalBoothId: matchedVoter.votedBoothId,
      });

      res.status(409).json({
        eligible: false,
        alreadyVoted: true,
        reason: 'ALREADY_VOTED_GLOBALLY',
        votedBoothId: matchedVoter.votedBoothId,
        lcdLine1: 'VOTE REJECTED',
        lcdLine2: 'ALREADY VOTED',
      });
      return;
    }

    if (booth.constituency && matchedVoter.constituency !== booth.constituency) {
      res.status(403).json({
        eligible: false,
        reason: 'CONSTITUENCY_MISMATCH',
        expectedConstituency: matchedVoter.constituency,
        lcdLine1: 'WRONG BOOTH',
        lcdLine2: matchedVoter.constituency.slice(0, 16),
      });
      return;
    }

    res.json({
      eligible: true,
      alreadyVoted: false,
      voterDocId: matchedVoter.voterDocId,
      constituency: matchedVoter.constituency,
      lcdLine1: 'VERIFIED - CAST',
      lcdLine2: 'SELECT CANDIDATE',
    });
  });

  // 5. Atomic Anti-Duplicate Vote Cast (Voter Identity Strictly Decoupled)
  app.post('/api/esp32/cast-vote', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const {
      electionId = booth.electionId,
      voterDocId,
      candidateId,
      idempotencyKey,
    } = req.body || {};

    if (!voterDocId || !candidateId || !idempotencyKey) {
      res.status(400).json({ error: 'MISSING_VOTE_FIELDS' });
      return;
    }

    if (committedIdempotencyKeys.has(idempotencyKey)) {
      res.json({
        accepted: true,
        status: 'DUPLICATE_IDEMPOTENCY_IGNORED',
        idempotencyKey,
        lcdLine1: 'VOTE CONFIRMED',
        lcdLine2: 'THANK YOU',
      });
      return;
    }

    const voter = gatewayVoters.get(voterDocId);
    if (!voter) {
      res.status(404).json({ accepted: false, reason: 'VOTER_NOT_FOUND' });
      return;
    }

    if (voter.hasVoted) {
      broadcastToDashboards('security:duplicate_attempt', {
        boothId: booth.boothId,
        electionId,
        voterDocId: voter.voterDocId,
        originalBoothId: voter.votedBoothId,
      });
      res.status(409).json({
        accepted: false,
        reason: 'DOUBLE_VOTE_BLOCKED',
        originalBoothId: voter.votedBoothId,
        lcdLine1: 'DUPLICATE BLOCK',
        lcdLine2: 'ALREADY VOTED',
      });
      return;
    }

    // Mark voter voted in gateway cache & generate anonymized receipt hash (no voterId stored in ballot)
    voter.hasVoted = true;
    voter.votedBoothId = booth.boothId;
    voter.votedAtIso = new Date().toISOString();
    committedIdempotencyKeys.add(idempotencyKey);

    const receiptHash = sha256Hex(`${electionId}:${candidateId}:${booth.boothId}:${idempotencyKey}:${Date.now()}`).slice(0, 24);

    // Broadcast strictly anonymized turnout update (NEVER broadcast candidateId to live dashboard!)
    broadcastToDashboards('esp32:vote_cast_sealed', {
      boothId: booth.boothId,
      electionId,
      constituency: booth.constituency,
      receiptHash,
      syncMode: 'online',
      candidateSplitHidden: true,
    });

    res.json({
      accepted: true,
      status: 'COMMITTED',
      receiptHash,
      idempotencyKey,
      anonymized: true,
      lcdLine1: 'VOTE RECORDED',
      lcdLine2: `REF ${receiptHash.slice(0, 8).toUpperCase()}`,
    });
  });

  // 6. Offline-Sync Batch Reconciliation & Deterministic Conflict Resolution
  app.post('/api/esp32/offline-sync', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const { electionId = booth.electionId, queuedVotes } = req.body || {};

    if (!Array.isArray(queuedVotes)) {
      res.status(400).json({ error: 'INVALID_OFFLINE_QUEUE' });
      return;
    }

    const results: Array<{
      idempotencyKey: string;
      localSeq: number;
      status: 'COMMITTED' | 'DUPLICATE_IGNORED' | 'CONFLICT_REJECTED_ALREADY_VOTED' | 'REJECTED_INVALID_VOTER';
      receiptHash?: string;
      conflictBoothId?: string | null;
      reason?: string;
    }> = [];

    let committedCount = 0;
    let duplicateIgnoredCount = 0;
    let conflictRejectedCount = 0;

    for (const item of queuedVotes) {
      const idempotencyKey = String(item.idempotencyKey || '');
      const localSeq = Number(item.localSeq || 0);
      const voterDocId = String(item.voterDocId || '');
      const candidateId = String(item.candidateId || '');

      if (!idempotencyKey || !voterDocId || !candidateId) {
        results.push({
          idempotencyKey,
          localSeq,
          status: 'REJECTED_INVALID_VOTER',
          reason: 'Malformed offline envelope',
        });
        continue;
      }

      if (committedIdempotencyKeys.has(idempotencyKey)) {
        duplicateIgnoredCount++;
        results.push({
          idempotencyKey,
          localSeq,
          status: 'DUPLICATE_IGNORED',
          reason: 'Idempotency key already reconciled',
        });
        continue;
      }

      const voter = gatewayVoters.get(voterDocId);
      if (!voter) {
        results.push({
          idempotencyKey,
          localSeq,
          status: 'REJECTED_INVALID_VOTER',
          reason: 'Voter document not found',
        });
        continue;
      }

      if (voter.hasVoted) {
        conflictRejectedCount++;
        results.push({
          idempotencyKey,
          localSeq,
          status: 'CONFLICT_REJECTED_ALREADY_VOTED',
          conflictBoothId: voter.votedBoothId,
          reason: `Voter already cast ballot at booth ${voter.votedBoothId || 'another booth'} prior to offline reconciliation`,
        });
        continue;
      }

      voter.hasVoted = true;
      voter.votedBoothId = booth.boothId;
      voter.votedAtIso = new Date().toISOString();
      committedIdempotencyKeys.add(idempotencyKey);
      committedCount++;

      const receiptHash = sha256Hex(`${electionId}:${candidateId}:${booth.boothId}:${idempotencyKey}`).slice(0, 24);
      results.push({
        idempotencyKey,
        localSeq,
        status: 'COMMITTED',
        receiptHash,
      });
    }

    booth.pendingOfflineVotes = 0;
    booth.offlineQueueBytes = 0;
    booth.status = booth.tamperState === 'nominal' ? 'online' : 'tampered';
    booth.syncState = conflictRejectedCount > 0 ? 'conflict_alert' : 'synced';
    booth.lastHeartbeatIso = new Date().toISOString();

    broadcastToDashboards('esp32:offline_sync_reconciled', {
      boothId: booth.boothId,
      electionId,
      committedCount,
      duplicateIgnoredCount,
      conflictRejectedCount,
      syncedAt: new Date().toISOString(),
    });

    res.json({
      reconciled: true,
      boothId: booth.boothId,
      summary: {
        totalProcessed: queuedVotes.length,
        committedCount,
        duplicateIgnoredCount,
        conflictRejectedCount,
      },
      results,
    });
  });

  // 7. Hardware Tamper Alert Endpoint
  app.post('/api/esp32/tamper', authenticateEsp32, (req, res) => {
    const booth = (req as Request & { booth: GatewayBooth }).booth;
    const {
      tamperState = 'enclosure_open',
      details = 'Hardware reed switch triggered on EVM chassis',
    } = req.body || {};

    booth.tamperState = tamperState;
    booth.status = 'tampered';
    booth.lcdMessage = 'TAMPER LOCKOUT';
    booth.lastHeartbeatIso = new Date().toISOString();

    broadcastToDashboards('esp32:tamper_alert', {
      boothId: booth.boothId,
      boothCode: booth.boothCode,
      tamperState,
      details,
    });

    res.json({
      acknowledged: true,
      action: 'LOCK_BOOTH_IMMEDIATELY',
      tamperState,
    });
  });

  // ==========================================================================
  // HTTP Server + Vite Dev Middleware + Isolated /ws WebSocket Upgrade
  // ==========================================================================
  const server = http.createServer(app);

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Use noServer: true so our /ws gateway never aborts Vite HMR or other upgrade paths
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
    const role = url.searchParams.get('role') || 'dashboard';
    const boothId = url.searchParams.get('boothId') || '';

    if (role === 'esp32' && boothId) {
      esp32Sockets.set(boothId, ws);
      broadcastToDashboards('ws:esp32_connected', { boothId });

      ws.on('close', () => {
        if (esp32Sockets.get(boothId) === ws) {
          esp32Sockets.delete(boothId);
          broadcastToDashboards('ws:esp32_disconnected', { boothId });
        }
      });
    } else {
      dashboardSockets.add(ws);
      ws.send(
        JSON.stringify({
          event: 'ws:init',
          timestamp: new Date().toISOString(),
          payload: {
            connectedEsp32Booths: Array.from(esp32Sockets.keys()),
            registeredBoothCount: gatewayBooths.size,
          },
        })
      );

      ws.on('close', () => {
        dashboardSockets.delete(ws);
      });
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Smart Vote Gateway] HTTP + WebSocket server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Smart Vote Gateway] Fatal startup error:', err);
  process.exit(1);
});
