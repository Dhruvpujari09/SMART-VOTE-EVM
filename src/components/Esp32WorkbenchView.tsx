import React, { useMemo, useState } from 'react';
import { serverTimestamp } from 'firebase/firestore';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Check,
  Code2,
  Copy,
  Cpu,
  Fingerprint,
  HardDrive,
  RefreshCw,
  Send,
  ShieldAlert,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  ESP32_ARDUINO_FIRMWARE_SNIPPET,
  ESP32_ENDPOINT_SPECS,
} from '../lib/esp32FirmwareSpecs';
import {
  appendAuditLog,
  castAnonymizedVoteInFirestore,
  reconcileOfflineQueueToFirestore,
  updateBoothTelemetry,
} from '../lib/firestoreService';
import { computeSha256Hex, ESP32_HARDWARE_IMAGE_URL } from '../lib/validation';
import type {
  Candidate,
  Election,
  EvmBooth,
  OfflineQueuedVote,
  UserRole,
  Voter,
} from '../types/evm';
import type { GatewayEventMessage } from '../hooks/useGatewaySocket';

interface Props {
  election: Election | null;
  booths: EvmBooth[];
  candidates: Candidate[];
  voters: Voter[];
  userRole: UserRole;
  initialBoothId?: string | null;
  gatewayConnected: boolean;
  gatewayEvents: GatewayEventMessage[];
  onOpenDocs?: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

interface HttpLogEntry {
  id: string;
  time: string;
  method: string;
  endpoint: string;
  status: number;
  request: unknown;
  response: unknown;
}

export const Esp32WorkbenchView: React.FC<Props> = ({
  election,
  booths,
  candidates,
  voters,
  userRole,
  initialBoothId,
  gatewayConnected,
  gatewayEvents,
  onOpenDocs,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<'console' | 'api' | 'firmware'>('console');
  const [selectedBoothId, setSelectedBoothId] = useState<string>(initialBoothId || booths[0]?.id || '');
  const [selectedVoterId, setSelectedVoterId] = useState<string>('');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('');
  const [rssi, setRssi] = useState(-54);
  const [latencyMs, setLatencyMs] = useState(41);
  const [batteryPct, setBatteryPct] = useState(93);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [httpLogs, setHttpLogs] = useState<HttpLogEntry[]>([]);

  // Per-booth simulated ESP32 LittleFS offline queue & local voted template cache
  const [offlineQueues, setOfflineQueues] = useState<Record<string, OfflineQueuedVote[]>>({});
  const [localVotedCaches, setLocalVotedCaches] = useState<Record<string, string[]>>({});
  const [lastSyncReport, setLastSyncReport] = useState<{
    boothCode: string;
    committed: number;
    conflicts: number;
    duplicates: number;
    details: Array<{ localSeq: number; voterName: string; outcome: string; reason: string }>;
  } | null>(null);

  const electionBooths = useMemo(
    () => (election ? booths.filter((b) => b.electionId === election.id) : booths),
    [booths, election]
  );

  const activeBooth = useMemo(
    () =>
      electionBooths.find((b) => b.id === selectedBoothId) ||
      electionBooths.find((b) => b.id === initialBoothId) ||
      electionBooths[0] ||
      null,
    [electionBooths, selectedBoothId, initialBoothId]
  );

  const boothCandidates = useMemo(() => {
    if (!activeBooth) return candidates;
    const filtered = candidates.filter((c) => c.constituency === activeBooth.constituency);
    return filtered.length > 0 ? filtered : candidates;
  }, [candidates, activeBooth]);

  const enrolledVoters = useMemo(
    () =>
      voters.filter(
        (v) =>
          (!election || v.electionId === election.id) &&
          v.enrollmentStatus === 'enrolled' &&
          Boolean(v.fingerprintTemplateId)
      ),
    [voters, election]
  );

  const currentQueue = activeBooth ? offlineQueues[activeBooth.id] || [] : [];
  const isBoothOffline = activeBooth?.status === 'offline';

  const recordHttpLog = (
    method: string,
    endpoint: string,
    status: number,
    request: unknown,
    response: unknown
  ) => {
    setHttpLogs((prev) =>
      [
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          time: new Date().toLocaleTimeString(),
          method,
          endpoint,
          status,
          request,
          response,
        },
        ...prev,
      ].slice(0, 12)
    );
  };

  const copyText = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const callEsp32Endpoint = async (
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>
  ) => {
    if (!activeBooth) return null;
    const res = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': activeBooth.id,
        'X-Device-API-Key': activeBooth.apiKeyHash,
      },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    recordHttpLog(method, endpoint, res.status, body || null, data);
    return { status: res.status, data };
  };

  // 1. Send Real Heartbeat
  const handleSendHeartbeat = async () => {
    if (!activeBooth) return;
    setBusy('heartbeat');
    try {
      const payload = {
        rssi,
        latencyMs,
        batteryPct,
        firmwareVersion: activeBooth.firmwareVersion,
        ballotVersion: activeBooth.ballotVersion,
        tamperState: activeBooth.tamperState,
        pendingOfflineVotes: currentQueue.length,
        offlineQueueBytes: currentQueue.reduce((s, q) => s + q.byteSize, 0),
        lcdMessage: rssi < -82 ? 'WEAK WIFI - READY' : 'READY - PLACE FINGER',
      };
      const res = await callEsp32Endpoint('POST', '/api/esp32/heartbeat', payload);
      if (res && res.status === 200) {
        const nextStatus =
          activeBooth.tamperState !== 'nominal'
            ? 'tampered'
            : rssi < -82 || latencyMs > 450
              ? 'degraded'
              : 'online';
        await updateBoothTelemetry(activeBooth.id, {
          status: nextStatus,
          wifiRssi: rssi,
          syncLatencyMs: latencyMs,
          batteryPct,
          lcdMessage: payload.lcdMessage,
        });
        onNotify(`Heartbeat acknowledged by gateway (${activeBooth.boothCode}: ${rssi} dBm, ${latencyMs} ms).`, 'success');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Heartbeat failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 2. Toggle ESP32 Offline Voting Mode (Simulates Wi-Fi Drop vs Reconnect)
  const handleToggleOfflineMode = async () => {
    if (!activeBooth) return;
    setBusy('toggle-offline');
    try {
      if (!isBoothOffline) {
        await updateBoothTelemetry(activeBooth.id, {
          status: 'offline',
          syncState: 'offline_queuing',
          wifiRssi: -99,
          syncLatencyMs: 0,
          offlineSince: serverTimestamp(),
          lcdMessage: `OFFLINE QUEUE (${currentQueue.length})`,
        });
        await appendAuditLog({
          category: 'OFFLINE_SYNC',
          action: 'ESP32_OFFLINE_MODE_ACTIVE',
          severity: 'warning',
          actorRole: userRole,
          boothId: activeBooth.id,
          electionId: activeBooth.electionId,
          summary: `${activeBooth.boothCode} entered Offline Voting Mode. Local LittleFS queue & on-device anti-duplicate bitset engaged.`,
        });
        onNotify(`${activeBooth.boothCode} disconnected from Wi-Fi. Votes will queue locally in LittleFS flash.`, 'info');
      } else {
        // Reconnect and flush offline queue if votes exist
        if (currentQueue.length > 0 && election) {
          await handleFlushOfflineQueue();
        } else {
          await updateBoothTelemetry(activeBooth.id, {
            status: activeBooth.tamperState === 'nominal' ? 'online' : 'tampered',
            syncState: 'synced',
            wifiRssi: rssi,
            syncLatencyMs: latencyMs,
            pendingOfflineVotes: 0,
            offlineQueueBytes: 0,
            offlineSince: null,
            lastSyncAt: serverTimestamp(),
            lcdMessage: 'ONLINE - SYNCED',
          });
          onNotify(`${activeBooth.boothCode} Wi-Fi restored and synced.`, 'success');
        }
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to change connectivity mode.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 3. Verify & Cast Vote (Online Real-Time OR Offline LittleFS Queue!)
  const handleCastSimulatedVote = async () => {
    if (!activeBooth || !election) return;
    const voter = enrolledVoters.find((v) => v.id === (selectedVoterId || enrolledVoters[0]?.id));
    const candidate = boothCandidates.find(
      (c) => c.id === (selectedCandidateId || boothCandidates[0]?.id)
    );

    if (!voter || !candidate) {
      onNotify('Select an enrolled voter and candidate first.', 'error');
      return;
    }

    if (election.status !== 'active') {
      onNotify(`Election is ${election.status}. Open polls before casting ballots.`, 'error');
      return;
    }

    setBusy('cast-vote');
    try {
      const idempotencyKey = `${activeBooth.boothCode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      if (isBoothOffline) {
        // OFFLINE VOTING MODE: Local anti-duplicate cache check on ESP32 flash
        const localVoted = localVotedCaches[activeBooth.id] || [];
        if (voter.fingerprintTemplateId && localVoted.includes(voter.fingerprintTemplateId)) {
          recordHttpLog('LOCAL_FLASH', 'LittleFS:/local_voted_templates.txt', 409, {
            templateId: voter.fingerprintTemplateId,
          }, {
            blockedLocally: true,
            reason: 'LOCAL_OFFLINE_DUPLICATE_BLOCKED',
            lcdLine1: 'DUPLICATE BLOCK',
            lcdLine2: 'VOTED LOCALLY',
          });
          onNotify(
            `Blocked locally on ${activeBooth.boothCode}: template ${voter.fingerprintTemplateId} already exists in ESP32 local_voted_templates.txt.`,
            'error'
          );
          return;
        }

        const nextSeq = currentQueue.length + 1;
        const mac = (
          await computeSha256Hex(`${activeBooth.id}:${nextSeq}:${voter.id}:${candidate.id}:${idempotencyKey}`)
        ).slice(0, 20);
        const envelope: OfflineQueuedVote = {
          localSeq: nextSeq,
          idempotencyKey,
          voterDocId: voter.id,
          voterName: voter.fullName,
          fingerprintTemplateId: voter.fingerprintTemplateId || 'FP-LOCAL',
          candidateId: candidate.id,
          candidateName: candidate.name,
          constituency: voter.constituency,
          capturedAt: new Date().toISOString(),
          payloadMac: mac,
          byteSize: 312,
        };

        const updatedQueue = [...currentQueue, envelope];
        const totalBytes = updatedQueue.reduce((sum, item) => sum + item.byteSize, 0);

        setOfflineQueues((prev) => ({ ...prev, [activeBooth.id]: updatedQueue }));
        if (voter.fingerprintTemplateId) {
          setLocalVotedCaches((prev) => ({
            ...prev,
            [activeBooth.id]: [...localVoted, voter.fingerprintTemplateId!],
          }));
        }

        // Reflect queued count & bytes in Firestore dashboard status (note: candidate choice stays strictly in ESP32 flash!)
        await updateBoothTelemetry(activeBooth.id, {
          status: 'offline',
          syncState: 'offline_queuing',
          pendingOfflineVotes: updatedQueue.length,
          offlineQueueBytes: totalBytes,
          lcdMessage: `OFFLINE QUEUE (${updatedQueue.length})`,
        });

        recordHttpLog('LOCAL_FLASH', 'LittleFS:/offline_queue.ndjson', 202, {
          localSeq: nextSeq,
          idempotencyKey,
          voterTemplateId: envelope.fingerprintTemplateId,
          payloadMac: mac,
          candidateHidden: true,
        }, {
          persistedToFlash: true,
          queueDepth: updatedQueue.length,
          queueBytes: totalBytes,
          lcdLine1: 'SAVED OFFLINE',
          lcdLine2: `SEQ #${nextSeq} QUEUED`,
        });

        onNotify(
          `Vote #${nextSeq} persisted to ${activeBooth.boothCode} LittleFS flash queue (${totalBytes} B). Reconnect Wi-Fi to reconcile.`,
          'info'
        );
        return;
      }

      // ONLINE MODE: 1) Verify eligibility via /api/esp32/verify-voter
      const verifyRes = await callEsp32Endpoint('POST', '/api/esp32/verify-voter', {
        electionId: election.id,
        fingerprintTemplateId: voter.fingerprintTemplateId,
      });

      if (!verifyRes || verifyRes.status !== 200) {
        const reason = String(verifyRes?.data?.reason || 'Verification failed');
        if (verifyRes?.status === 409) {
          await appendAuditLog({
            category: 'SECURITY',
            action: 'CROSS_BOOTH_DUPLICATE_BLOCKED',
            severity: 'critical',
            actorRole: userRole,
            boothId: activeBooth.id,
            electionId: election.id,
            summary: `${activeBooth.boothCode} rejected fingerprint ${voter.fingerprintTemplateId}: voter ${voter.voterIdNumber} already voted globally.`,
          });
        }
        onNotify(`ESP32 Verification Denied: ${reason}`, 'error');
        return;
      }

      // 2) Cast decoupled vote via /api/esp32/cast-vote + commit atomically to Firestore
      const castRes = await callEsp32Endpoint('POST', '/api/esp32/cast-vote', {
        electionId: election.id,
        voterDocId: voter.id,
        candidateId: candidate.id,
        idempotencyKey,
      });

      if (castRes && castRes.status === 200) {
        const fsRes = await castAnonymizedVoteInFirestore({
          election,
          voter,
          candidate,
          booth: activeBooth,
          idempotencyKey,
          syncMode: 'online',
          actorRole: userRole,
        });
        onNotify(
          `Vote recorded & anonymized (Receipt ${fsRes.receiptHash.slice(0, 8).toUpperCase()}). Voter marked globally as voted.`,
          'success'
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Vote casting error.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 4. Reconnect Wi-Fi & Flush Offline Queue with Deterministic Conflict Resolution
  const handleFlushOfflineQueue = async () => {
    if (!activeBooth || !election) return;
    if (currentQueue.length === 0) {
      onNotify('No locally queued offline ballots in this booth simulator.', 'info');
      return;
    }

    setBusy('flush-queue');
    try {
      // Hit real Express /api/esp32/offline-sync endpoint
      await callEsp32Endpoint('POST', '/api/esp32/offline-sync', {
        electionId: election.id,
        queuedVotes: currentQueue.map((q) => ({
          localSeq: q.localSeq,
          idempotencyKey: q.idempotencyKey,
          voterDocId: q.voterDocId,
          candidateId: q.candidateId,
          capturedAt: q.capturedAt,
          payloadMac: q.payloadMac,
        })),
      });

      // Reconcile into Firestore with cross-booth conflict detection
      const report = await reconcileOfflineQueueToFirestore({
        election,
        booth: activeBooth,
        queuedVotes: currentQueue,
        voters,
        candidates,
        actorRole: userRole,
      });

      setOfflineQueues((prev) => ({ ...prev, [activeBooth.id]: [] }));
      setLastSyncReport({
        boothCode: activeBooth.boothCode,
        ...report,
      });

      onNotify(
        `Offline sync complete for ${activeBooth.boothCode}: ${report.committed} committed, ${report.conflicts} cross-booth conflict(s) rejected.`,
        report.conflicts > 0 ? 'error' : 'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Offline sync reconciliation failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 5. Trigger Hardware Tamper Alert
  const handleTriggerTamper = async () => {
    if (!activeBooth) return;
    setBusy('tamper');
    try {
      await callEsp32Endpoint('POST', '/api/esp32/tamper', {
        tamperState: 'enclosure_open',
        details: 'Chassis reed switch opened during live polling session',
      });
      await updateBoothTelemetry(activeBooth.id, {
        status: 'tampered',
        tamperState: 'enclosure_open',
        lcdMessage: 'TAMPER LOCKOUT',
      });
      await appendAuditLog({
        category: 'SECURITY',
        action: 'ESP32_TAMPER_TRIGGERED',
        severity: 'critical',
        actorRole: userRole,
        boothId: activeBooth.id,
        electionId: activeBooth.electionId,
        summary: `Hardware reed switch triggered on ${activeBooth.boothCode}. Terminal locked pending Election Administrator inspection.`,
      });
      onNotify(`Tamper lockout triggered on ${activeBooth.boothCode} and logged to audit trail.`, 'error');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Tamper trigger failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // 6. Download Compact Ballot Manifest via GET /api/esp32/ballot
  const handlePullBallotManifest = async () => {
    if (!activeBooth || !election) return;
    setBusy('pull-ballot');
    try {
      const res = await callEsp32Endpoint(
        'GET',
        `/api/esp32/ballot?electionId=${encodeURIComponent(election.id)}`
      );
      if (res && res.status === 200) {
        onNotify(
          `Downloaded compact ballot v${res.data.ballotVersion} (${res.data.payloadBytes} bytes) to ${activeBooth.boothCode}.`,
          'success'
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Hardware Architecture Banner + Sub-Navigation Tabs */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-3 items-stretch">
        <div className="lg:col-span-2 p-6 flex flex-col justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-sky-400">
              <span>ESP32-WROOM-32</span>
              <span className="text-slate-600">·</span>
              <span>R307 / AS608 Optical UART</span>
              <span className="text-slate-600">·</span>
              <span className={gatewayConnected ? 'text-emerald-400' : 'text-amber-400'}>
                {gatewayConnected ? 'Gateway WS Live' : 'Gateway Connecting'}
              </span>
            </div>
            <h2 className="text-xl font-semibold text-slate-100">
              ESP32 Hardware Workbench, Offline Voting & API Specification
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
              Test live authenticated REST & WebSocket hardware flows, simulate Wi-Fi drops with durable LittleFS flash queueing and deterministic cross-booth conflict resolution, or copy the Arduino/ESP-IDF firmware reference.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1120] border border-slate-800 rounded-lg w-fit">
              {[
                { id: 'console', label: 'Interactive Device Console' },
                { id: 'api', label: 'ESP32 JSON API Spec' },
                { id: 'firmware', label: 'Offline Firmware & Deployment' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSubTab(t.id as typeof subTab)}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    subTab === t.id
                      ? 'bg-[#1B2740] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {onOpenDocs && (
              <button
                type="button"
                onClick={onOpenDocs}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 text-xs font-medium transition-colors cursor-pointer"
              >
                <BookOpen className="w-3.5 h-3.5" />
                Setup &amp; Connection Docs
              </button>
            )}
          </div>
        </div>

        <div className="relative min-h-[200px] sm:min-h-[220px] aspect-[16/9] lg:aspect-auto bg-[#0B1120] border-t lg:border-t-0 lg:border-l border-slate-800 overflow-hidden">
          <img
            src={ESP32_HARDWARE_IMAGE_URL}
            alt="ESP32 Fingerprint Electronic Voting Machine terminal hardware"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover block"
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0B1120]/90 via-[#0B1120]/40 to-transparent px-4 py-3">
            <span className="font-mono text-[11px] text-slate-200">
              Reference Terminal · TLS 1.3 + LittleFS Offline Queue
            </span>
          </div>
        </div>
      </div>

      {/* SUB-TAB 1: INTERACTIVE ESP32 DEVICE CONSOLE & OFFLINE SIMULATOR */}
      {subTab === 'console' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left 7 Columns: Hardware Terminal Controls */}
          <div className="xl:col-span-7 space-y-6">
            {!activeBooth ? (
              <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
                Provision an ESP32 booth or seed the sample election to test hardware endpoints.
              </div>
            ) : (
              <>
                {/* Terminal Selector & Physical 16x2 LCD + Connectivity Mode */}
                <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <label htmlFor="wb-booth-select" className="text-xs font-medium text-slate-400">
                        Active Hardware Unit
                      </label>
                      <select
                        id="wb-booth-select"
                        value={activeBooth.id}
                        onChange={(e) => setSelectedBoothId(e.target.value)}
                        className="bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-400"
                      >
                        {electionBooths.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.boothCode} — {b.constituency} ({b.status})
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void handleToggleOfflineMode()}
                      className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                        isBoothOffline
                          ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                          : 'bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200'
                      }`}
                    >
                      {isBoothOffline ? (
                        <>
                          <Wifi className="w-3.5 h-3.5" />
                          Restore Wi-Fi & Auto-Sync
                        </>
                      ) : (
                        <>
                          <WifiOff className="w-3.5 h-3.5" />
                          Simulate Wi-Fi Drop (Offline Mode)
                        </>
                      )}
                    </button>
                  </div>

                  {/* Simulated 16x2 Industrial Monochrome LCD & LED Indicators */}
                  <div className="bg-[#08101C] border border-slate-700 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1 font-mono">
                      <div className="text-[11px] text-slate-500">
                        16x2 I2C LCD · {activeBooth.boothCode} · {activeBooth.apiKeyPrefix}…
                      </div>
                      <div className="text-base text-sky-300 tracking-wider font-semibold">
                        {activeBooth.lcdMessage}
                      </div>
                      <div className="text-xs text-slate-400">
                        {isBoothOffline
                          ? `LOCAL FLASH: ${currentQueue.length} QUEUED (${currentQueue.reduce((s, q) => s + q.byteSize, 0)} B)`
                          : `RSSI ${activeBooth.wifiRssi} dBm · BALLOT V${activeBooth.ballotVersion}`}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-[11px] font-mono text-slate-400 shrink-0">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isBoothOffline ? 'bg-amber-400' : 'bg-emerald-400'
                          }`}
                        />
                        {isBoothOffline ? 'OFFLINE' : 'WIFI OK'}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            activeBooth.tamperState === 'nominal' ? 'bg-emerald-400' : 'bg-red-500'
                          }`}
                        />
                        {activeBooth.tamperState === 'nominal' ? 'SEAL OK' : 'TAMPER'}
                      </span>
                    </div>
                  </div>

                  {/* Biometric Verify + Vote Cast (Online or Offline Flash Queue) */}
                  <div className="space-y-3 pt-1">
                    <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                      <Fingerprint className="w-4 h-4 text-sky-400" />
                      {isBoothOffline
                        ? 'Offline Biometric Vote Capture (Writes to LittleFS Flash Ring-Queue)'
                        : 'Live Biometric Verification & Atomic Anonymized Vote Cast'}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Scanned Enrolled Voter (Template ID)
                        </label>
                        <select
                          value={selectedVoterId || enrolledVoters[0]?.id || ''}
                          onChange={(e) => setSelectedVoterId(e.target.value)}
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                        >
                          {enrolledVoters.length === 0 ? (
                            <option value="">No enrolled voters available</option>
                          ) : (
                            enrolledVoters.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.fingerprintTemplateId} · {v.fullName} ({v.constituency}) {v.hasVoted ? '[ALREADY VOTED]' : '[ELIGIBLE]'}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Tactile Keypad Candidate Selection
                        </label>
                        <select
                          value={selectedCandidateId || boothCandidates[0]?.id || ''}
                          onChange={(e) => setSelectedCandidateId(e.target.value)}
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                        >
                          {boothCandidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              KEY #{c.ballotNumber} · {c.name} ({c.party})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        disabled={busy !== null || enrolledVoters.length === 0}
                        onClick={() => void handleCastSimulatedVote()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-xs transition-colors cursor-pointer"
                      >
                        <Fingerprint className="w-3.5 h-3.5" />
                        {isBoothOffline
                          ? 'Scan & Queue Vote in LittleFS'
                          : 'Verify Biometric & Cast Anonymized Vote'}
                      </button>

                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handlePullBallotManifest()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-200 text-xs font-medium cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5 text-sky-400" />
                        GET /api/esp32/ballot
                      </button>

                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleTriggerTamper()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/35 text-red-300 text-xs font-medium cursor-pointer"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        Trigger Tamper Switch
                      </button>
                    </div>
                  </div>
                </div>

                {/* Local LittleFS Offline Queue Inspector & Reconcile Panel */}
                <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-amber-400" />
                        ESP32 LittleFS Offline Queue ({activeBooth.boothCode})
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Queued votes persist locally across power cycles and reconcile deterministically via <code className="font-mono text-slate-300">/api/esp32/offline-sync</code> on reconnect.
                      </p>
                    </div>
                    {currentQueue.length > 0 && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleFlushOfflineQueue()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs cursor-pointer"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {busy === 'flush-queue'
                          ? 'Reconciling…'
                          : `Reconnect & Flush ${currentQueue.length} Vote(s)`}
                      </button>
                    )}
                  </div>

                  {currentQueue.length === 0 ? (
                    <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 text-xs text-slate-400">
                      Local flash buffer <code className="font-mono text-slate-300">/offline_queue.ndjson</code> is empty (0 bytes pending). Toggle <strong className="text-slate-200">Simulate Wi-Fi Drop</strong> above to test offline voting and cross-booth duplicate conflict resolution.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg overflow-hidden">
                      {currentQueue.map((item) => (
                        <div
                          key={item.idempotencyKey}
                          className="px-4 py-2.5 bg-[#0B1120] flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <span className="font-mono text-amber-400">SEQ #{item.localSeq}</span>
                            <span className="text-slate-600 mx-2">·</span>
                            <span className="text-slate-200">{item.voterName}</span>
                            <span className="text-slate-600 mx-2">·</span>
                            <span className="font-mono text-slate-400">{item.fingerprintTemplateId}</span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            MAC {item.payloadMac.slice(0, 10)}… · {item.byteSize} B
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {lastSyncReport && (
                    <div className="bg-[#0B1120] border border-slate-700 rounded-lg p-4 space-y-2.5 text-xs">
                      <div className="flex items-center justify-between font-medium">
                        <span className="text-slate-200">
                          Last Offline Sync Report ({lastSyncReport.boothCode})
                        </span>
                        <span className="font-mono tabular-nums text-slate-400">
                          {lastSyncReport.committed} committed · {lastSyncReport.conflicts} conflict(s) · {lastSyncReport.duplicates} dup
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {lastSyncReport.details.map((d) => (
                          <div
                            key={`${d.localSeq}-${d.voterName}`}
                            className="flex items-start justify-between gap-2 text-[11px] font-mono"
                          >
                            <span className="text-slate-300">
                              #{d.localSeq} {d.voterName}: {d.reason}
                            </span>
                            <span
                              className={
                                d.outcome === 'COMMITTED'
                                  ? 'text-emerald-400 shrink-0'
                                  : 'text-red-400 shrink-0'
                              }
                            >
                              {d.outcome}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Heartbeat Telemetry Controls */}
                <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-sky-400" />
                      Heartbeat & Radio Telemetry Controls
                    </h3>
                    <button
                      type="button"
                      disabled={busy !== null || isBoothOffline}
                      onClick={() => void handleSendHeartbeat()}
                      className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 disabled:opacity-40 text-slate-100 text-xs font-medium cursor-pointer"
                    >
                      POST /api/esp32/heartbeat
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">Wi-Fi RSSI</span>
                        <span className="font-mono text-slate-200 tabular-nums">{rssi} dBm</span>
                      </div>
                      <input
                        type="range"
                        min={-95}
                        max={-35}
                        value={rssi}
                        onChange={(e) => setRssi(Number(e.target.value))}
                        className="w-full accent-sky-400"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">Sync Latency</span>
                        <span className="font-mono text-slate-200 tabular-nums">{latencyMs} ms</span>
                      </div>
                      <input
                        type="range"
                        min={15}
                        max={900}
                        step={5}
                        value={latencyMs}
                        onChange={(e) => setLatencyMs(Number(e.target.value))}
                        className="w-full accent-sky-400"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">UPS Battery</span>
                        <span className="font-mono text-slate-200 tabular-nums">{batteryPct}%</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={batteryPct}
                        onChange={(e) => setBatteryPct(Number(e.target.value))}
                        className="w-full accent-sky-400"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right 5 Columns: Live REST & WebSocket Wire Inspector */}
          <div className="xl:col-span-5 space-y-6">
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 flex flex-col h-[540px]">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  Live ESP32 Wire Inspector
                </h3>
                <span className="font-mono text-[11px] text-slate-500">
                  {httpLogs.length} call{httpLogs.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 mt-3 pr-1">
                {httpLogs.length === 0 ? (
                  <div className="py-12 text-center text-xs text-slate-500 space-y-2">
                    <Cpu className="w-6 h-6 mx-auto text-slate-600" />
                    <p>Trigger any ESP32 action on the left to inspect live JSON payloads and HTTP status codes.</p>
                  </div>
                ) : (
                  httpLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className="bg-[#0B1120] border border-slate-800 rounded-lg p-3 space-y-2 font-mono text-[11px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sky-400 truncate">
                          {entry.method} {entry.endpoint}
                        </span>
                        <span
                          className={`shrink-0 ${
                            entry.status >= 200 && entry.status < 300
                              ? 'text-emerald-400'
                              : entry.status === 409
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }`}
                        >
                          HTTP {entry.status} · {entry.time}
                        </span>
                      </div>
                      <pre className="text-slate-300 overflow-x-auto leading-relaxed">
                        {JSON.stringify(entry.response, null, 2)}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Real-Time WebSocket Event Stream */}
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">WebSocket Event Bus (/ws)</h3>
                <span className="font-mono text-[11px] text-slate-400">
                  {gatewayEvents.length} frame{gatewayEvents.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="max-h-44 overflow-y-auto divide-y divide-slate-800/80 font-mono text-[11px]">
                {gatewayEvents.length === 0 ? (
                  <div className="py-4 text-slate-500">Listening for real-time gateway events…</div>
                ) : (
                  gatewayEvents.slice(0, 8).map((ev) => (
                    <div key={ev.id} className="py-2 flex items-center justify-between gap-2">
                      <span className="text-sky-400 truncate">{ev.event}</span>
                      <span className="text-slate-500 shrink-0">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: COMPLETE ESP32 JSON API SPECIFICATION */}
      {subTab === 'api' && (
        <div className="space-y-4">
          <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-slate-400">Base Gateway URL: </span>
              <code className="font-mono text-sky-400">{window.location.origin}</code>
              <span className="text-slate-600 mx-2">·</span>
              <span className="text-slate-400">Transport: </span>
              <code className="font-mono text-emerald-400">TLS 1.3 HTTPS + WSS (/ws?role=esp32&amp;boothId=...)</code>
            </div>
            <span className="font-mono text-slate-400">Auth: X-Device-ID + X-Device-API-Key</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {ESP32_ENDPOINT_SPECS.map((spec) => (
              <div
                key={spec.path}
                className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs text-sky-400 font-semibold">
                      {spec.method} {spec.path}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{spec.purpose}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(spec.path, `${spec.method} ${spec.path}\n${spec.headers}\n\n${spec.requestJson}`)}
                    className="p-1.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-300 cursor-pointer"
                    aria-label={`Copy ${spec.path}`}
                  >
                    {copiedId === spec.path ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2 font-mono text-[11px]">
                  <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3 overflow-x-auto">
                    <div className="text-slate-500 mb-1">Request Payload</div>
                    <pre className="text-slate-200">{spec.requestJson}</pre>
                  </div>
                  <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3 overflow-x-auto">
                    <div className="text-slate-500 mb-1">Response JSON</div>
                    <pre className="text-emerald-300">{spec.responseJson}</pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-TAB 3: ARDUINO/ESP-IDF OFFLINE FIRMWARE & DEPLOYMENT SPEC */}
      {subTab === 'firmware' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-2">
              <div className="text-xs font-mono text-amber-400">01. DURABLE FLASH QUEUE</div>
              <h3 className="text-sm font-semibold text-slate-100">LittleFS Ring-Log + NVS Counter</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                When Wi-Fi drops, votes append with immediate <code className="font-mono text-slate-300">fsync()</code> to <code className="font-mono text-slate-300">/offline_queue.ndjson</code> using a monotonic NVS sequence key and HMAC-SHA256 MAC. Local flash is only truncated after HTTP 200 reconciliation.
              </p>
            </div>
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-2">
              <div className="text-xs font-mono text-sky-400">02. ANTI-DUPLICATE PROTECTION</div>
              <h3 className="text-sm font-semibold text-slate-100">Dual Local + Cloud Guard</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                On-device <code className="font-mono text-slate-300">/local_voted_templates.txt</code> blocks repeat scans immediately at the offline booth. On reconnect, <code className="font-mono text-slate-300">/api/esp32/offline-sync</code> rejects cross-booth double votes atomically without incrementing tallies.
              </p>
            </div>
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-2">
              <div className="text-xs font-mono text-emerald-400">03. DEPLOYMENT ARCHITECTURE</div>
              <h3 className="text-sm font-semibold text-slate-100">PWA + Express Gateway + Firestore</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Deploy <code className="font-mono text-slate-300">npm run build &amp;&amp; npm start</code> behind TLS (Cloud Run / Nginx), deploy hardened <code className="font-mono text-slate-300">firestore.rules</code>, and pin the Root CA + per-booth <code className="font-mono text-slate-300">sv_esp32_*</code> key into ESP32 NVS flash.
              </p>
            </div>
          </div>

          <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Code2 className="w-4 h-4 text-sky-400" />
                ESP32 Arduino / ESP-IDF Offline Queue & Sync Reference (C++)
              </div>
              <button
                type="button"
                onClick={() => copyText('firmware', ESP32_ARDUINO_FIRMWARE_SNIPPET)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-xs text-slate-200 cursor-pointer"
              >
                {copiedId === 'firmware' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Copied C++
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy Firmware
                  </>
                )}
              </button>
            </div>
            <pre className="p-5 bg-[#0B1120] font-mono text-xs text-slate-300 overflow-x-auto leading-relaxed">
              {ESP32_ARDUINO_FIRMWARE_SNIPPET}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
