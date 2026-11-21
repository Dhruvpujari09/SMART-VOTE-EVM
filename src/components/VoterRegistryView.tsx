import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Fingerprint,
  Search,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  completeFingerprintEnrollment,
  dispatchFingerprintEnrollmentCommand,
  registerVoterRecord,
} from '../lib/firestoreService';
import type { Election, EvmBooth, UserRole, Voter } from '../types/evm';

interface Props {
  election: Election | null;
  voters: Voter[];
  booths: EvmBooth[];
  userRole: UserRole;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

export const VoterRegistryView: React.FC<Props> = ({
  election,
  voters,
  booths,
  userRole,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'enrolled' | 'voted'>('all');
  const [constituencyFilter, setConstituencyFilter] = useState<string>('all');

  // Register Voter Form
  const [fullName, setFullName] = useState('');
  const [voterIdNumber, setVoterIdNumber] = useState('');
  const [constituency, setConstituency] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Remote Biometric Enrollment Modal
  const [enrollTarget, setEnrollTarget] = useState<Voter | null>(null);
  const [selectedBoothId, setSelectedBoothId] = useState('');
  const [enrollStage, setEnrollStage] = useState<'select' | 'dispatched' | 'scanning' | 'complete'>('select');
  const [capturedTemplateId, setCapturedTemplateId] = useState('');

  const electionVoters = useMemo(
    () => (election ? voters.filter((v) => v.electionId === election.id) : []),
    [voters, election]
  );

  const onlineBooths = useMemo(
    () =>
      booths.filter(
        (b) =>
          (!election || b.electionId === election.id) &&
          (b.status === 'online' || b.status === 'degraded')
      ),
    [booths, election]
  );

  const filteredVoters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return electionVoters.filter((v) => {
      if (constituencyFilter !== 'all' && v.constituency !== constituencyFilter) return false;
      if (statusFilter === 'pending' && v.enrollmentStatus === 'enrolled') return false;
      if (statusFilter === 'enrolled' && v.enrollmentStatus !== 'enrolled') return false;
      if (statusFilter === 'voted' && !v.hasVoted) return false;
      if (!q) return true;
      return (
        v.fullName.toLowerCase().includes(q) ||
        v.voterIdNumber.toLowerCase().includes(q) ||
        (v.fingerprintTemplateId || '').toLowerCase().includes(q)
      );
    });
  }, [electionVoters, search, statusFilter, constituencyFilter]);

  const handleRegisterVoter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!election) return;
    if (fullName.trim().length < 2 || voterIdNumber.trim().length < 3) {
      onNotify('Enter full name and government Voter ID number.', 'error');
      return;
    }

    const duplicate = electionVoters.some(
      (v) => v.voterIdNumber.toLowerCase() === voterIdNumber.trim().toLowerCase()
    );
    if (duplicate) {
      onNotify(`Voter ID ${voterIdNumber.trim().toUpperCase()} is already registered in this election.`, 'error');
      return;
    }

    setSubmitting(true);
    try {
      await registerVoterRecord({
        fullName: fullName.trim(),
        voterIdNumber: voterIdNumber.trim(),
        constituency: constituency || election.constituencies[0],
        electionId: election.id,
        actorRole: userRole,
      });
      setFullName('');
      setVoterIdNumber('');
      onNotify('Voter registered. Select "Enroll Biometric" to pair an opaque ESP32 fingerprint template ID.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to register voter.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openEnrollModal = (voter: Voter) => {
    setEnrollTarget(voter);
    const preferred =
      onlineBooths.find((b) => b.constituency === voter.constituency) || onlineBooths[0];
    setSelectedBoothId(preferred?.id || '');
    setEnrollStage('select');
    setCapturedTemplateId('');
  };

  const handleDispatchRemoteEnroll = async () => {
    if (!enrollTarget) return;
    const booth = booths.find((b) => b.id === selectedBoothId);
    if (!booth) {
      onNotify('Select an online ESP32 booth to perform fingerprint enrollment.', 'error');
      return;
    }
    try {
      await dispatchFingerprintEnrollmentCommand({
        voter: enrollTarget,
        booth,
        actorRole: userRole,
      });
      setEnrollStage('dispatched');
      onNotify(`ENROLL_FINGERPRINT command queued for ${booth.boothCode}. Waiting for R307/AS608 capture.`, 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to dispatch command.', 'error');
    }
  };

  const handleSimulateEsp32Capture = async () => {
    if (!enrollTarget) return;
    const booth = booths.find((b) => b.id === selectedBoothId);
    if (!booth) return;

    setEnrollStage('scanning');
    const nextSlot = 100 + electionVoters.filter((v) => v.fingerprintTemplateId).length + Math.floor(Math.random() * 80 + 1);
    const templateId = `FP-${nextSlot}`;

    try {
      // Also notify the live Express gateway endpoint so WebSocket listeners see the hardware response
      await fetch('/api/esp32/enroll-complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-ID': booth.id,
          'X-Device-API-Key': booth.apiKeyHash,
        },
        body: JSON.stringify({
          voterDocId: enrollTarget.id,
          fingerprintTemplateId: templateId,
          qualityScore: 96,
        }),
      }).catch(() => undefined);

      await completeFingerprintEnrollment({
        voter: enrollTarget,
        booth,
        templateId,
        actorRole: userRole,
      });
      setCapturedTemplateId(templateId);
      setEnrollStage('complete');
      onNotify(`Mapped opaque template ${templateId} to ${enrollTarget.fullName} (zero raw biometrics stored).`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to complete enrollment.', 'error');
      setEnrollStage('dispatched');
    }
  };

  if (!election) {
    return (
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
        Create or seed an election first to register voters and map ESP32 fingerprint template IDs.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Left 2 Columns: Voter Table & Controls */}
      <div className="xl:col-span-2 space-y-4">
        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voter name, ID, or FP template…"
              className="w-full bg-[#0B1120] border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={constituencyFilter}
              onChange={(e) => setConstituencyFilter(e.target.value)}
              className="bg-[#0B1120] border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-400"
            >
              <option value="all">All Constituencies</option>
              {election.constituencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <div className="flex items-center p-1 bg-[#0B1120] border border-slate-800 rounded-lg">
              {(['all', 'pending', 'enrolled', 'voted'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize cursor-pointer ${
                    statusFilter === tab
                      ? 'bg-[#1B2740] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>
              Showing <strong className="text-slate-200 font-mono tabular-nums">{filteredVoters.length}</strong> of{' '}
              <strong className="text-slate-200 font-mono tabular-nums">{electionVoters.length}</strong> voters
            </span>
            <span className="hidden sm:inline">Privacy Guarantee: Only opaque ESP32 template IDs stored</span>
          </div>

          {/* Mobile Stacked Voter Cards */}
          <div className="md:hidden divide-y divide-slate-800/80">
            {filteredVoters.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-slate-400">
                No matching voters found for the current filters.
              </div>
            ) : (
              filteredVoters.map((voter) => {
                const votedBooth = booths.find((b) => b.id === voter.votedBoothId);
                return (
                  <div key={voter.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100 truncate">{voter.fullName}</div>
                        <div className="font-mono text-xs text-slate-400">
                          {voter.voterIdNumber} · {voter.constituency}
                        </div>
                      </div>
                      <span className="font-mono text-xs shrink-0">
                        {voter.enrollmentStatus === 'enrolled' && voter.fingerprintTemplateId ? (
                          <span className="text-emerald-400">{voter.fingerprintTemplateId}</span>
                        ) : voter.enrollmentStatus === 'enrolling' ? (
                          <span className="text-amber-400">Scanning…</span>
                        ) : (
                          <span className="text-slate-500">Unenrolled</span>
                        )}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div>
                        {voter.hasVoted ? (
                          <span className="text-sky-400 font-medium">
                            Voted ({votedBooth?.boothCode || 'Locked'})
                          </span>
                        ) : (
                          <span className="text-slate-400">Eligible to Vote</span>
                        )}
                      </div>

                      {voter.hasVoted ? (
                        <span className="text-xs text-slate-500 font-mono">Terminal Lock</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openEnrollModal(voter)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] text-slate-100 text-xs font-medium cursor-pointer"
                        >
                          <Fingerprint className="w-3.5 h-3.5 text-sky-400" />
                          {voter.enrollmentStatus === 'enrolled' ? 'Re-Enroll' : 'Enroll Biometric'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop 5-Column Voter Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0F172A]/70 text-xs text-slate-400">
                  <th className="py-3 px-4 font-medium">Voter Profile</th>
                  <th className="py-3 px-4 font-medium">Constituency</th>
                  <th className="py-3 px-4 font-medium">Biometric Template</th>
                  <th className="py-3 px-4 font-medium">Anti-Duplicate Status</th>
                  <th className="py-3 px-4 font-medium text-right">Enrollment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {filteredVoters.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-xs text-slate-400">
                      No matching voters found for the current filters.
                    </td>
                  </tr>
                ) : (
                  filteredVoters.map((voter) => {
                    const votedBooth = booths.find((b) => b.id === voter.votedBoothId);
                    return (
                      <tr key={voter.id} className="hover:bg-slate-800/35 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-100">{voter.fullName}</div>
                          <div className="font-mono text-xs text-slate-400">{voter.voterIdNumber}</div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300">{voter.constituency}</td>
                        <td className="py-3 px-4 font-mono text-xs">
                          {voter.enrollmentStatus === 'enrolled' && voter.fingerprintTemplateId ? (
                            <span className="text-emerald-400">{voter.fingerprintTemplateId}</span>
                          ) : voter.enrollmentStatus === 'enrolling' ? (
                            <span className="text-amber-400">Awaiting ESP32 scan…</span>
                          ) : (
                            <span className="text-slate-500">Unenrolled</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {voter.hasVoted ? (
                            <div>
                              <span className="text-sky-400 font-medium">Voted (Locked)</span>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {votedBooth?.boothCode || 'Booth synced'}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400">Eligible</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          {voter.hasVoted ? (
                            <span className="text-xs text-slate-600 font-mono">Terminal Lock</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openEnrollModal(voter)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Fingerprint className="w-3.5 h-3.5 text-sky-400" />
                              {voter.enrollmentStatus === 'enrolled' ? 'Re-Enroll' : 'Enroll Biometric'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Right Column: Register New Voter Form */}
      <div className="space-y-6">
        <form
          onSubmit={(e) => void handleRegisterVoter(e)}
          className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-4 h-4 text-sky-400" />
            <h2 className="text-base font-semibold text-slate-100">Register Voter</h2>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Available to both Election Administrators and Polling Officers. Biometric template mapping happens on-device via an ESP32 R307/AS608 scanner.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Full Legal Name</label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={120}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g., Meera Krishnan"
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Government Voter ID</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={40}
                value={voterIdNumber}
                onChange={(e) => setVoterIdNumber(e.target.value)}
                placeholder="e.g., SV-ND-1089"
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono uppercase focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Constituency</label>
              <select
                value={constituency || election.constituencies[0]}
                onChange={(e) => setConstituency(e.target.value)}
                className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
              >
                {election.constituencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
          >
            {submitting ? 'Registering…' : 'Register Voter Profile'}
          </button>
        </form>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Biometric Privacy Architecture
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Raw fingerprint ridge scans never leave the optical R307/AS608 module. The ESP32 stores templates in local flash and transmits only an opaque integer slot ID (e.g., <span className="font-mono text-slate-200">FP-104</span>) back to Firestore.
          </p>
        </div>
      </div>

      {/* Remote ESP32 Fingerprint Enrollment Modal */}
      {enrollTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md bg-[#131C2E] border border-slate-700 rounded-xl p-6 space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Remote ESP32 Biometric Enrollment
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {enrollTarget.fullName} · <span className="font-mono">{enrollTarget.voterIdNumber}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEnrollTarget(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer"
                aria-label="Close enrollment modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {enrollStage === 'select' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">
                    Target Connected ESP32 Terminal
                  </label>
                  <select
                    value={selectedBoothId}
                    onChange={(e) => setSelectedBoothId(e.target.value)}
                    className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
                  >
                    {onlineBooths.length === 0 ? (
                      <option value="">No online ESP32 booths available</option>
                    ) : (
                      onlineBooths.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.boothCode} — {b.name} ({b.constituency})
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 text-xs text-slate-400 space-y-1">
                  <div className="text-slate-200 font-medium">Command Payload Preview</div>
                  <pre className="font-mono text-[11px] text-sky-300 overflow-x-auto">
{JSON.stringify(
  {
    type: 'ENROLL_FINGERPRINT',
    voterDocId: enrollTarget.id,
    voterIdNumber: enrollTarget.voterIdNumber,
  },
  null,
  2
)}
                  </pre>
                </div>

                <button
                  type="button"
                  disabled={!selectedBoothId}
                  onClick={() => void handleDispatchRemoteEnroll()}
                  className="w-full py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
                >
                  Dispatch Command to ESP32
                </button>
              </div>
            )}

            {(enrollStage === 'dispatched' || enrollStage === 'scanning') && (
              <div className="space-y-4">
                <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-400 flex items-center justify-center mx-auto">
                    <Fingerprint className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-100">
                      {enrollStage === 'scanning'
                        ? 'Completing Two-Pass Optical Match…'
                        : 'Command Active on ESP32 LCD'}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Instruct voter to place finger twice on the R307/AS608 optical scanner. Or trigger the hardware callback below to test completion immediately.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={enrollStage === 'scanning'}
                  onClick={() => void handleSimulateEsp32Capture()}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
                >
                  <Cpu className="w-4 h-4" />
                  {enrollStage === 'scanning' ? 'Mapping Template ID…' : 'Simulate ESP32 Two-Pass Capture'}
                </button>
              </div>
            )}

            {enrollStage === 'complete' && (
              <div className="space-y-4 text-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
                <div>
                  <div className="text-base font-semibold text-slate-100">
                    Biometric Template Paired
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Stored opaque ID <span className="font-mono text-emerald-400">{capturedTemplateId}</span> in Firestore. Raw fingerprint imagery never left the microcontroller.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnrollTarget(null)}
                  className="w-full py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm cursor-pointer"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
