import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Lock,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  addCandidateRecord,
  closeElectionPolls,
  createElectionRecord,
  deleteCandidateRecord,
  deleteElectionAndClearStorage,
  provisionEsp32Booth,
  purgePreviousElectionsAndServerStorage,
  pushValidatedBallotToBooths,
  updateElectionSchedule,
} from '../lib/firestoreService';
import {
  ESP32_ARDUINO_JSON_LIMIT_BYTES,
  PARTY_EMBLEM_PRESETS,
  resolveEmblemUrl,
  runPreElectionValidation,
} from '../lib/validation';
import type {
  Candidate,
  Election,
  EvmBooth,
  PreElectionValidationReport,
  UserRole,
} from '../types/evm';

interface Props {
  elections: Election[];
  selectedElection: Election | null;
  onSelectElection: (id: string) => void;
  candidates: Candidate[];
  booths: EvmBooth[];
  userRole: UserRole;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

export const ElectionManagementView: React.FC<Props> = ({
  elections,
  selectedElection,
  onSelectElection,
  candidates,
  booths,
  userRole,
  onNotify,
}) => {
  const isAdmin = userRole === 'admin';
  const [validationReport, setValidationReport] = useState<PreElectionValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Create Election Form State
  const [showCreateElection, setShowCreateElection] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newConstituencies, setNewConstituencies] = useState('North District, Harbor Ward');
  const [newStart, setNewStart] = useState(() => new Date(Date.now() + 15 * 60000).toISOString().slice(0, 16));
  const [newEnd, setNewEnd] = useState(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16));

  // Edit Schedule Form State
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  // Add Candidate Form State
  const [candName, setCandName] = useState('');
  const [candParty, setCandParty] = useState('');
  const [candConstituency, setCandConstituency] = useState('');
  const [candBallotNum, setCandBallotNum] = useState(1);
  const [candLogoUrl, setCandLogoUrl] = useState<string>(PARTY_EMBLEM_PRESETS[0].url);
  const [candColor, setCandColor] = useState<string>(PARTY_EMBLEM_PRESETS[0].color);

  // Provision Booth Form State
  const [boothCode, setBoothCode] = useState('');
  const [boothName, setBoothName] = useState('');
  const [boothConstituency, setBoothConstituency] = useState('');
  const [newlyIssuedKey, setNewlyIssuedKey] = useState<{ boothId: string; boothCode: string; apiKey: string } | null>(null);

  // Safe Inline Deletion Confirmation State
  const [confirmDeleteElectionId, setConfirmDeleteElectionId] = useState<string | null>(null);
  const [confirmPurgePrevious, setConfirmPurgePrevious] = useState(false);

  const previousElections = useMemo(
    () => elections.filter((el) => el.status !== 'active'),
    [elections]
  );

  const electionBooths = useMemo(
    () => (selectedElection ? booths.filter((b) => b.electionId === selectedElection.id) : []),
    [booths, selectedElection]
  );

  useEffect(() => {
    if (selectedElection && selectedElection.constituencies.length > 0) {
      setCandConstituency((prev) =>
        selectedElection.constituencies.includes(prev) ? prev : selectedElection.constituencies[0]
      );
      setBoothConstituency((prev) =>
        selectedElection.constituencies.includes(prev) ? prev : selectedElection.constituencies[0]
      );
      setEditStart(selectedElection.startTime.slice(0, 16));
      setEditEnd(selectedElection.endTime.slice(0, 16));
    }
  }, [selectedElection]);

  // Run Pre-Election Configuration Validation automatically whenever election/candidates/booths change
  useEffect(() => {
    let active = true;
    if (!selectedElection) {
      setValidationReport(null);
      return;
    }
    setValidating(true);
    void runPreElectionValidation(selectedElection, candidates, booths).then((report) => {
      if (active) {
        setValidationReport(report);
        setValidating(false);
      }
    });
    return () => {
      active = false;
    };
  }, [selectedElection, candidates, booths]);

  const handleCreateElection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    const constituencyList = newConstituencies
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (newTitle.trim().length < 3) {
      onNotify('Election title must be at least 3 characters.', 'error');
      return;
    }
    if (constituencyList.length === 0) {
      onNotify('Enter at least one constituency name.', 'error');
      return;
    }

    setBusyAction('create-election');
    try {
      const id = await createElectionRecord({
        title: newTitle.trim(),
        description: newDescription.trim(),
        constituencies: constituencyList,
        startTime: new Date(newStart).toISOString(),
        endTime: new Date(newEnd).toISOString(),
      });
      onSelectElection(id);
      setShowCreateElection(false);
      setNewTitle('');
      setNewDescription('');
      onNotify('Draft election created. Add candidates and verify configuration before pushing to ESP32 devices.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create election.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveSchedule = async () => {
    if (!selectedElection || !isAdmin) return;
    setBusyAction('save-schedule');
    try {
      await updateElectionSchedule(selectedElection.id, {
        title: selectedElection.title,
        description: selectedElection.description,
        constituencies: selectedElection.constituencies,
        startTime: new Date(editStart).toISOString(),
        endTime: new Date(editEnd).toISOString(),
      });
      setEditingSchedule(false);
      onNotify('Polling schedule updated. Re-running pre-election validation.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update schedule.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedElection || !isAdmin) return;
    if (candName.trim().length < 2 || candParty.trim().length < 2) {
      onNotify('Candidate name and party affiliation are required.', 'error');
      return;
    }

    setBusyAction('add-candidate');
    try {
      await addCandidateRecord({
        electionId: selectedElection.id,
        name: candName.trim(),
        party: candParty.trim(),
        constituency: candConstituency || selectedElection.constituencies[0],
        ballotNumber: Number(candBallotNum),
        symbolUrl: candLogoUrl.trim(),
        accentColor: candColor,
      });
      setCandName('');
      setCandParty('');
      setCandBallotNum((n) => Math.min(99, n + 1));
      onNotify('Candidate added to ballot. Pre-election validation updated.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to add candidate.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleProvisionBooth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedElection || !isAdmin) return;
    if (boothCode.trim().length < 2 || boothName.trim().length < 2) {
      onNotify('Provide a valid booth code (e.g., EVM-N03) and station name.', 'error');
      return;
    }
    setBusyAction('add-booth');
    try {
      const result = await provisionEsp32Booth({
        boothCode: boothCode.trim(),
        name: boothName.trim(),
        constituency: boothConstituency || selectedElection.constituencies[0],
        electionId: selectedElection.id,
      });
      setNewlyIssuedKey({
        boothId: result.boothId,
        boothCode: boothCode.trim().toUpperCase(),
        apiKey: result.plainApiKey,
      });
      setBoothCode('');
      setBoothName('');
      onNotify(`Provisioned ESP32 booth ${boothCode.trim().toUpperCase()}. Save the API key below for firmware flashing.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to provision booth.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePushBallot = async (activatePolls: boolean) => {
    if (!selectedElection || !isAdmin) return;
    if (!validationReport?.readyToDeploy) {
      onNotify('Resolve all blocking pre-election validation checks before pushing to ESP32 booths.', 'error');
      return;
    }
    setBusyAction(activatePolls ? 'open-and-push' : 'push-ballot');
    try {
      const res = await pushValidatedBallotToBooths({
        election: selectedElection,
        candidates,
        booths,
        activatePolls,
      });
      onNotify(
        `${activatePolls ? 'Polls opened & ' : ''}Ballot v${res.ballotVersion} pushed to ${res.pushedCount} ESP32 booth(s) (SHA-256 ${res.ballotHash.slice(0, 10)}…).`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to push ballot configuration.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleClosePolls = async () => {
    if (!selectedElection || !isAdmin) return;
    setBusyAction('close-polls');
    try {
      await closeElectionPolls(selectedElection, booths);
      onNotify('Polls closed and ESP32 terminals locked. Proceed to Sealed Results to re-authenticate and unseal tallies.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to close polls.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteSingleElection = async (target: Election) => {
    if (!isAdmin) return;
    setBusyAction(`delete-${target.id}`);
    try {
      const res = await deleteElectionAndClearStorage(target);
      setConfirmDeleteElectionId(null);
      if (selectedElection?.id === target.id) {
        const next = elections.find((e) => e.id !== target.id);
        onSelectElection(next?.id || '');
      }
      onNotify(
        `Deleted "${target.title}" and cleared server storage (${res.deletedCandidates} candidates, ${res.deletedBallots} ballots, ${res.deletedBooths} booths, ${res.deletedVoters} voters purged).`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete election and clear storage.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePurgeAllPreviousElections = async () => {
    if (!isAdmin || previousElections.length === 0) return;
    setBusyAction('purge-previous');
    try {
      const res = await purgePreviousElectionsAndServerStorage(previousElections);
      setConfirmPurgePrevious(false);
      const remaining = elections.find((e) => e.status === 'active');
      onSelectElection(remaining?.id || '');
      onNotify(
        `Cleared ${res.deletedElections} previous election(s) and purged ${res.totalDocsPurged} Firestore records + Express server gateway storage.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to clear previous elections.', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Elections Directory & Server Storage Cleanup Card */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Elections Directory &amp; Server Storage Cleanup
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select an election to configure, or permanently delete previous elections to clear Firestore records and Express gateway storage.
            </p>
          </div>

          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => setShowCreateElection((v) => !v)}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                New Election
              </button>

              {selectedElection && selectedElection.status === 'active' && (
                <button
                  type="button"
                  onClick={() => void handleClosePolls()}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  {busyAction === 'close-polls' ? 'Closing Polls…' : 'Close Active Polls'}
                </button>
              )}

              {previousElections.length > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => {
                    setConfirmDeleteElectionId(null);
                    setConfirmPurgePrevious((v) => !v);
                  }}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Database className="w-3.5 h-3.5" />
                  Clear Previous Elections ({previousElections.length})
                </button>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
              Read-only view — Election Administrator privileges required for mutations.
            </div>
          )}
        </div>

        {/* Inline Bulk Purge Confirmation Banner */}
        {confirmPurgePrevious && isAdmin && previousElections.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1 text-xs">
              <div className="font-semibold text-red-200 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                Permanently delete {previousElections.length} previous (closed/draft) election(s) &amp; clear server storage?
              </div>
              <p className="text-red-200/80">
                This removes all associated Firestore candidates, ballots, sealed tallies, booths, voters, and purges Express gateway memory cache. Immutable audit records are preserved.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setConfirmPurgePrevious(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-[#0B1120] hover:bg-slate-800 text-slate-200 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction === 'purge-previous'}
                onClick={() => void handlePurgeAllPreviousElections()}
                className="px-3.5 py-1.5 rounded-lg bg-red-500 hover:bg-red-400 text-slate-950 text-xs font-semibold cursor-pointer"
              >
                {busyAction === 'purge-previous' ? 'Clearing Storage…' : 'Confirm & Clear Storage'}
              </button>
            </div>
          </div>
        )}

        {/* Scannable List of All Elections with Direct Delete Buttons */}
        {elections.length === 0 ? (
          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-6 text-center text-xs text-slate-400">
            No elections stored. Click <strong className="text-slate-200">New Election</strong> above or use <strong className="text-slate-200">Seed Sample Election</strong> in the sidebar.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {elections.map((el) => {
              const isSelected = selectedElection?.id === el.id;
              const isConfirming = confirmDeleteElectionId === el.id;
              const isDeletingThis = busyAction === `delete-${el.id}`;
              return (
                <div
                  key={el.id}
                  className={`rounded-lg border p-3.5 transition-colors flex flex-col justify-between gap-3 ${
                    isSelected
                      ? 'bg-[#0B1120] border-sky-500/50'
                      : 'bg-[#0B1120]/70 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onSelectElection(el.id)}
                      className="text-left min-w-0 flex-1 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            el.status === 'active'
                              ? 'bg-emerald-400'
                              : el.status === 'closed'
                                ? 'bg-amber-400'
                                : 'bg-slate-500'
                          }`}
                        />
                        <span className="text-sm font-semibold text-slate-100 truncate">
                          {el.title}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
                        <span className="uppercase">{el.status}</span>
                        <span>·</span>
                        <span>Ballot v{el.ballotVersion}</span>
                        <span>·</span>
                        <span>{el.totalVotesCast} / {el.totalRegisteredVoters} voted</span>
                      </div>
                    </button>

                    {isAdmin && !isConfirming && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => {
                          setConfirmPurgePrevious(false);
                          setConfirmDeleteElectionId(el.id);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700/80 hover:border-red-500/40 hover:bg-red-500/10 text-slate-400 hover:text-red-300 text-xs font-medium transition-colors shrink-0 cursor-pointer"
                        title={`Delete ${el.title} and clear server storage`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    )}
                  </div>

                  {isAdmin && isConfirming && (
                    <div className="bg-red-500/10 border border-red-500/35 rounded-md px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-red-200">
                        Delete &amp; purge Firestore + server cache?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteElectionId(null)}
                          className="px-2.5 py-1 rounded border border-slate-700 bg-[#0B1120] text-slate-300 hover:text-slate-100 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={isDeletingThis}
                          onClick={() => void handleDeleteSingleElection(el)}
                          className="px-2.5 py-1 rounded bg-red-500 hover:bg-red-400 text-slate-950 font-semibold cursor-pointer"
                        >
                          {isDeletingThis ? 'Purging…' : 'Confirm Delete'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create New Election Drawer */}
      {showCreateElection && isAdmin && (
        <form
          onSubmit={(e) => void handleCreateElection(e)}
          className="bg-[#131C2E] border border-sky-500/30 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-100">Create Draft Election</h3>
            <button
              type="button"
              onClick={() => setShowCreateElection(false)}
              className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Election Title</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={120}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g., 2026 Municipal Council Election"
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Constituencies (comma-separated)</label>
              <input
                type="text"
                required
                value={newConstituencies}
                onChange={(e) => setNewConstituencies(e.target.value)}
                placeholder="North District, Harbor Ward"
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Polls Open (Local Time)</label>
              <input
                type="datetime-local"
                required
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Polls Close (Local Time)</label>
              <input
                type="datetime-local"
                required
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-sky-400"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Description</label>
            <input
              type="text"
              maxLength={500}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Scope, jurisdiction, and biometric verification policy"
              className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busyAction === 'create-election'}
              className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
            >
              {busyAction === 'create-election' ? 'Creating…' : 'Create Draft Election'}
            </button>
          </div>
        </form>
      )}

      {selectedElection && (
        <>
          {/* PRE-ELECTION CONFIGURATION VALIDATION WORKFLOW */}
          <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div className="flex items-start gap-3">
                <div
                  className={`p-2 rounded-lg border shrink-0 mt-0.5 ${
                    validationReport?.readyToDeploy
                      ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/25 text-red-400'
                  }`}
                >
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    Pre-Election Configuration Validation Gate
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Automated verification of schedule logic, duplicate candidates, keypad collisions, verified emblems, and ESP32 ArduinoJson memory budgets prior to live hardware push.
                  </p>
                </div>
              </div>

              {isAdmin && selectedElection.status !== 'closed' && (
                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  {selectedElection.status === 'draft' && (
                    <button
                      type="button"
                      disabled={!validationReport?.readyToDeploy || busyAction !== null}
                      onClick={() => void handlePushBallot(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-xs transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {busyAction === 'open-and-push' ? 'Opening & Pushing…' : 'Open Polls & Push to ESP32'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!validationReport?.readyToDeploy || busyAction !== null}
                    onClick={() => void handlePushBallot(false)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 disabled:opacity-50 text-slate-100 font-medium text-xs transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
                  >
                    <Send className="w-3.5 h-3.5 text-sky-400" />
                    {busyAction === 'push-ballot'
                      ? 'Pushing Ballot…'
                      : `Push Ballot v${selectedElection.ballotVersion + 1} to Booths`}
                  </button>
                </div>
              )}
            </div>

            {validating || !validationReport ? (
              <div className="py-6 text-center text-xs text-slate-400 font-mono">
                Running pre-election configuration checks…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 flex items-center justify-between">
                    <span className="text-slate-400">Deployment Gate</span>
                    <span
                      className={`font-semibold ${
                        validationReport.readyToDeploy ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {validationReport.readyToDeploy
                        ? 'PASSED — Ready to Push'
                        : `BLOCKED (${validationReport.blockingFailures} failure${validationReport.blockingFailures === 1 ? '' : 's'})`}
                    </span>
                  </div>
                  <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 flex items-center justify-between">
                    <span className="text-slate-400">ESP32 JSON Payload</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {validationReport.ballotPayloadBytes} B / {ESP32_ARDUINO_JSON_LIMIT_BYTES} B
                    </span>
                  </div>
                  <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 flex items-center justify-between gap-2">
                    <span className="text-slate-400 shrink-0">Manifest SHA-256</span>
                    <span className="font-mono text-sky-400 truncate">
                      {validationReport.computedBallotHash.slice(0, 18)}…
                    </span>
                  </div>
                </div>

                {/* Polling Window Quick Fix Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg bg-[#0B1120] border border-slate-800 text-xs">
                  <div className="text-slate-300">
                    <span className="text-slate-400">Scheduled Window: </span>
                    <span className="font-mono">
                      {new Date(selectedElection.startTime).toLocaleString()} → {new Date(selectedElection.endTime).toLocaleString()}
                    </span>
                  </div>
                  {isAdmin && selectedElection.status !== 'closed' && (
                    <button
                      type="button"
                      onClick={() => setEditingSchedule((v) => !v)}
                      className="text-sky-400 hover:text-sky-300 font-medium cursor-pointer"
                    >
                      {editingSchedule ? 'Cancel Edit' : 'Adjust Schedule'}
                    </button>
                  )}
                </div>

                {editingSchedule && isAdmin && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end bg-[#0B1120] border border-sky-500/30 rounded-lg p-4">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Start Time</label>
                      <input
                        type="datetime-local"
                        value={editStart}
                        onChange={(e) => setEditStart(e.target.value)}
                        className="w-full bg-[#131C2E] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">End Time</label>
                      <input
                        type="datetime-local"
                        value={editEnd}
                        onChange={(e) => setEditEnd(e.target.value)}
                        className="w-full bg-[#131C2E] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSaveSchedule()}
                      disabled={busyAction === 'save-schedule'}
                      className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs cursor-pointer"
                    >
                      Save & Re-Validate
                    </button>
                  </div>
                )}

                {/* Validation Checklist Rows */}
                <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-lg overflow-hidden">
                  {validationReport.checks.map((check) => (
                    <div
                      key={check.id}
                      className="px-4 py-3 flex items-start justify-between gap-4 bg-[#0F172A]/60"
                    >
                      <div className="flex items-start gap-3">
                        {check.status === 'pass' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : check.status === 'warn' ? (
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <div className="text-sm font-medium text-slate-100">{check.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{check.detail}</div>
                        </div>
                      </div>
                      <span
                        className={`text-xs font-mono shrink-0 ${
                          check.status === 'pass'
                            ? 'text-emerald-400'
                            : check.status === 'warn'
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }`}
                      >
                        {check.status === 'pass'
                          ? 'PASS'
                          : check.status === 'warn'
                            ? 'WARN'
                            : 'BLOCKING FAIL'}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Candidates & Ballot Builder + Provision ESP32 Booths */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2 bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-100">Candidate Ballot Roster</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Candidate records contain zero vote counts; tallies are isolated inside rule-locked sealed documents.
                  </p>
                </div>
                <span className="font-mono text-xs text-slate-400 tabular-nums">
                  {candidates.length} candidate{candidates.length === 1 ? '' : 's'}
                </span>
              </div>

              {/* Mobile Candidate Cards */}
              <div className="sm:hidden divide-y divide-slate-800/80">
                {candidates.length === 0 ? (
                  <div className="py-8 px-4 text-center text-slate-400 text-xs">
                    No candidates configured yet. Add at least 2 candidates per constituency.
                  </div>
                ) : (
                  candidates.map((cand) => (
                    <div key={cand.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-700 bg-[#0B1120] shrink-0 flex items-center justify-center">
                          <img
                            src={resolveEmblemUrl(cand.symbolUrl, cand.ballotNumber - 1)}
                            alt={`${cand.party} emblem`}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (!img.dataset.fallbackApplied) {
                                img.dataset.fallbackApplied = '1';
                                img.src = PARTY_EMBLEM_PRESETS[(Math.max(0, cand.ballotNumber - 1)) % PARTY_EMBLEM_PRESETS.length].url;
                              }
                            }}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-sky-400 tabular-nums shrink-0">
                              KEY #{cand.ballotNumber}
                            </span>
                            <span className="font-medium text-sm text-slate-100 truncate">
                              {cand.name}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 truncate mt-0.5">
                            {cand.party} · {cand.constituency}
                          </div>
                        </div>
                      </div>
                      {isAdmin && selectedElection.status !== 'closed' && (
                        <button
                          type="button"
                          onClick={() =>
                            void deleteCandidateRecord(selectedElection.id, cand)
                              .then(() => onNotify(`Removed ${cand.name} from ballot.`, 'info'))
                              .catch((err) => onNotify(String(err), 'error'))
                          }
                          className="p-2 rounded-md text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0 cursor-pointer"
                          aria-label={`Remove ${cand.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Desktop Candidate Table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-[#0F172A]/70 text-xs text-slate-400">
                      <th className="py-3 px-4 font-medium">Keypad #</th>
                      <th className="py-3 px-4 font-medium">Candidate & Party</th>
                      <th className="py-3 px-4 font-medium">Constituency</th>
                      {isAdmin && selectedElection.status !== 'closed' && (
                        <th className="py-3 px-4 font-medium text-right">Remove</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 text-sm">
                    {candidates.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-slate-400 text-xs">
                          No candidates configured yet. Add at least 2 candidates per constituency.
                        </td>
                      </tr>
                    ) : (
                      candidates.map((cand) => (
                        <tr key={cand.id} className="hover:bg-slate-800/35 transition-colors">
                          <td className="py-3 px-4 font-mono text-xs text-sky-400 tabular-nums">
                            KEY #{cand.ballotNumber}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-700 bg-[#0B1120] shrink-0 flex items-center justify-center">
                                <img
                                  src={resolveEmblemUrl(cand.symbolUrl, cand.ballotNumber - 1)}
                                  alt={`${cand.party} emblem`}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    const img = e.currentTarget;
                                    if (!img.dataset.fallbackApplied) {
                                      img.dataset.fallbackApplied = '1';
                                      img.src = PARTY_EMBLEM_PRESETS[(Math.max(0, cand.ballotNumber - 1)) % PARTY_EMBLEM_PRESETS.length].url;
                                    }
                                  }}
                                />
                              </div>
                              <div>
                                <div className="font-medium text-slate-100">{cand.name}</div>
                                <div className="text-xs text-slate-400">{cand.party}</div>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-300">{cand.constituency}</td>
                          {isAdmin && selectedElection.status !== 'closed' && (
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() =>
                                  void deleteCandidateRecord(selectedElection.id, cand)
                                    .then(() => onNotify(`Removed ${cand.name} from ballot.`, 'info'))
                                    .catch((err) => onNotify(String(err), 'error'))
                                }
                                className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                                aria-label={`Remove ${cand.name}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Column: Add Candidate & Provision Booth Forms */}
            <div className="space-y-6">
              {isAdmin && selectedElection.status !== 'closed' && (
                <form
                  onSubmit={(e) => void handleAddCandidate(e)}
                  className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4"
                >
                  <h3 className="text-sm font-semibold text-slate-100">Add Ballot Candidate</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={100}
                        value={candName}
                        onChange={(e) => setCandName(e.target.value)}
                        placeholder="e.g., Clara Lindholm"
                        className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Party / Coalition</label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={100}
                        value={candParty}
                        onChange={(e) => setCandParty(e.target.value)}
                        placeholder="e.g., Civic Alliance"
                        className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Constituency</label>
                        <select
                          value={candConstituency}
                          onChange={(e) => setCandConstituency(e.target.value)}
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                        >
                          {selectedElection.constituencies.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">ESP32 Keypad #</label>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          required
                          value={candBallotNum}
                          onChange={(e) => setCandBallotNum(Number(e.target.value))}
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono tabular-nums focus:outline-none focus:border-sky-400"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1.5">Party Emblem Preset</label>
                      <div className="grid grid-cols-4 gap-2">
                        {PARTY_EMBLEM_PRESETS.map((preset) => (
                          <button
                            key={preset.url}
                            type="button"
                            onClick={() => {
                              setCandLogoUrl(preset.url);
                              setCandColor(preset.color);
                            }}
                            className={`p-1.5 rounded-lg border transition-colors flex items-center justify-center cursor-pointer ${
                              candLogoUrl === preset.url
                                ? 'border-sky-400 bg-sky-500/10'
                                : 'border-slate-700 bg-[#0B1120] hover:border-slate-500'
                            }`}
                            title={preset.label}
                          >
                            <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-700/70 bg-[#0B1120]">
                              <img
                                src={preset.url}
                                alt={preset.label}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Emblem Asset URL</label>
                      <input
                        type="text"
                        value={candLogoUrl}
                        onChange={(e) => setCandLogoUrl(e.target.value)}
                        placeholder="/src/assets/images/..."
                        className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-sky-400"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={busyAction === 'add-candidate'}
                    className="w-full py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs transition-colors cursor-pointer"
                  >
                    {busyAction === 'add-candidate' ? 'Saving…' : 'Add Candidate to Ballot'}
                  </button>
                </form>
              )}

              {isAdmin && (
                <form
                  onSubmit={(e) => void handleProvisionBooth(e)}
                  className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-sky-400" />
                      Provision ESP32 Booth
                    </h3>
                    <span className="font-mono text-xs text-slate-500 tabular-nums">
                      {electionBooths.length} active
                    </span>
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Booth Code</label>
                        <input
                          type="text"
                          required
                          value={boothCode}
                          onChange={(e) => setBoothCode(e.target.value)}
                          placeholder="EVM-N03"
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-400"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Constituency</label>
                        <select
                          value={boothConstituency}
                          onChange={(e) => setBoothConstituency(e.target.value)}
                          className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                        >
                          {selectedElection.constituencies.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Polling Station Name</label>
                      <input
                        type="text"
                        required
                        value={boothName}
                        onChange={(e) => setBoothName(e.target.value)}
                        placeholder="Central Community Hall — Desk 3"
                        className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={busyAction === 'add-booth'}
                    className="w-full py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 font-medium text-xs transition-colors cursor-pointer"
                  >
                    {busyAction === 'add-booth' ? 'Generating TLS Key…' : 'Provision Booth & Generate API Key'}
                  </button>

                  {newlyIssuedKey && (
                    <div className="bg-[#0B1120] border border-emerald-500/30 rounded-lg p-3 space-y-2">
                      <div className="text-xs font-medium text-emerald-400">
                        One-Time ESP32 API Key Issued ({newlyIssuedKey.boothCode})
                      </div>
                      <div className="font-mono text-[11px] text-slate-200 break-all bg-[#131C2E] p-2 rounded border border-slate-800">
                        {newlyIssuedKey.apiKey}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(newlyIssuedKey.apiKey);
                          onNotify('Copied ESP32 API key to clipboard.', 'info');
                        }}
                        className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        Copy Key for Firmware NVS
                      </button>
                    </div>
                  )}
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
