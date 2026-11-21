import React, { useEffect, useMemo, useState } from 'react';
import { doc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import {
  CheckCircle2,
  Download,
  KeyRound,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { closeElectionPolls, unsealElectionResultsWithReauth } from '../lib/firestoreService';
import { PARTY_EMBLEM_PRESETS, resolveEmblemUrl } from '../lib/validation';
import type { Candidate, Election, EvmBooth, SealedTally, UserRole, Voter } from '../types/evm';

interface Props {
  election: Election | null;
  candidates: Candidate[];
  booths: EvmBooth[];
  voters: Voter[];
  userRole: UserRole;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

export const SealedResultsView: React.FC<Props> = ({
  election,
  candidates,
  booths,
  voters,
  userRole,
  onNotify,
}) => {
  const isAdmin = userRole === 'admin';
  const [tally, setTally] = useState<SealedTally | null>(null);
  const [unsealing, setUnsealing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ruleProbeResult, setRuleProbeResult] = useState<{
    status: 'idle' | 'blocked' | 'readable';
    message: string;
  }>({ status: 'idle', message: '' });

  const electionId = election?.id ?? null;
  // Wait for server-acknowledged unsealedAt Timestamp (null during local optimistic pending writes)
  // AND completion of the unseal commit before subscribing to database-locked sealed_tallies.
  const isUnsealPendingCommit = Boolean(
    election &&
      isAdmin &&
      election.status === 'closed' &&
      election.resultsUnsealed &&
      (!election.unsealedAt || unsealing)
  );
  const canReadSealedTally = Boolean(
    election &&
      isAdmin &&
      election.status === 'closed' &&
      election.resultsUnsealed &&
      Boolean(election.unsealedAt) &&
      !unsealing
  );

  // Only subscribe to sealed_tallies/official after Firestore server confirms the unseal commit!
  useEffect(() => {
    setTally(null);
    setRuleProbeResult({ status: 'idle', message: '' });
    if (!electionId || !canReadSealedTally) return;

    let cancelled = false;
    let activeUnsub: (() => void) | null = null;
    let retryTimer: number | null = null;
    const path = `elections/${electionId}/sealed_tallies/official`;
    const tallyRef = doc(db, 'elections', electionId, 'sealed_tallies', 'official');

    const attachListener = (attempt: number) => {
      if (cancelled) return;
      activeUnsub = onSnapshot(
        tallyRef,
        (snap) => {
          if (!cancelled && snap.exists()) {
            setTally(snap.data() as SealedTally);
          }
        },
        (err) => {
          if (cancelled) return;
          const isPermissionDenied =
            err && typeof err === 'object' && 'code' in err && err.code === 'permission-denied';
          if (isPermissionDenied && attempt < 3) {
            retryTimer = window.setTimeout(() => {
              attachListener(attempt + 1);
            }, 350 * (attempt + 1));
            return;
          }
          handleFirestoreError(err, OperationType.GET, path);
        }
      );
    };

    attachListener(0);

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (activeUnsub) activeUnsub();
    };
  }, [electionId, canReadSealedTally]);

  const turnoutStats = useMemo(() => {
    if (!election) return { registered: 0, cast: 0, pct: '0.0', byConstituency: [] as Array<{ name: string; cast: number; reg: number; pct: string }> };
    const electionVoters = voters.filter((v) => v.electionId === election.id);
    const registered = electionVoters.length || election.totalRegisteredVoters;
    const cast = electionVoters.filter((v) => v.hasVoted).length || election.totalVotesCast;
    const pct = registered > 0 ? ((cast / registered) * 100).toFixed(1) : '0.0';
    const byConstituency = election.constituencies.map((c) => {
      const cReg = electionVoters.filter((v) => v.constituency === c).length;
      const cCast = electionVoters.filter((v) => v.constituency === c && v.hasVoted).length;
      return {
        name: c,
        cast: cCast,
        reg: cReg,
        pct: cReg > 0 ? ((cCast / cReg) * 100).toFixed(1) : '0.0',
      };
    });
    return { registered, cast, pct, byConstituency };
  }, [election, voters]);

  const candidateRows = useMemo(() => {
    if (!tally) return [];
    const total = Math.max(
      1,
      Object.values(tally.counts || {}).reduce((sum, v) => sum + Number(v || 0), 0)
    );
    return candidates
      .map((c) => {
        const votes = Number(tally.counts?.[c.id] || 0);
        return {
          ...c,
          votes,
          sharePct: Number(((votes / total) * 100).toFixed(1)),
        };
      })
      .sort((a, b) => b.votes - a.votes);
  }, [candidates, tally]);

  // Live Database-Rule Enforcement Proof Probe
  const handleVerifyDbRuleLock = async () => {
    if (!election) return;
    try {
      await getDocFromServer(doc(db, 'elections', election.id, 'sealed_tallies', 'official'));
      setRuleProbeResult({
        status: 'readable',
        message: 'Read succeeded: Election is closed, unsealed, and caller holds Election Administrator privileges.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRuleProbeResult({
        status: 'blocked',
        message: `Firestore Rules Enforced (${msg}). Candidate vote splits cannot be read from the database while sealed.`,
      });
    }
  };

  const handleClosePollsHere = async () => {
    if (!election || !isAdmin) return;
    setClosing(true);
    try {
      await closeElectionPolls(election, booths);
      onNotify('Polls closed. You may now re-authenticate with Google to unseal candidate tallies.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to close polls.', 'error');
    } finally {
      setClosing(false);
    }
  };

  const handleReauthAndUnseal = async () => {
    if (!election || !isAdmin) return;
    setUnsealing(true);
    try {
      await unsealElectionResultsWithReauth(election);
      onNotify('Google re-authentication verified. Results unsealed and logged to immutable audit trail.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Re-authentication cancelled or failed.';
      onNotify(msg, 'error');
    } finally {
      setUnsealing(false);
    }
  };

  const handleExportResults = (format: 'json' | 'csv') => {
    if (!election || !tally) return;
    let content = '';
    let mime = 'application/json';
    let ext = 'json';

    if (format === 'json') {
      content = JSON.stringify(
        {
          electionId: election.id,
          title: election.title,
          status: election.status,
          unsealedByEmail: election.unsealedByEmail || null,
          totalRegisteredVoters: turnoutStats.registered,
          totalVotesCast: turnoutStats.cast,
          results: candidateRows.map((r) => ({
            ballotNumber: r.ballotNumber,
            name: r.name,
            party: r.party,
            constituency: r.constituency,
            votes: r.votes,
            sharePct: r.sharePct,
          })),
        },
        null,
        2
      );
    } else {
      mime = 'text/csv';
      ext = 'csv';
      const header = 'BallotNumber,Candidate,Party,Constituency,Votes,SharePct';
      const rows = candidateRows.map(
        (r) => `${r.ballotNumber},"${r.name}","${r.party}","${r.constituency}",${r.votes},${r.sharePct}%`
      );
      content = [header, ...rows].join('\n');
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-vote-results-${election.id}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!election) {
    return (
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
        No election selected. Seed or create an election to monitor turnout and unseal results.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Always-Visible Live Total Voter Turnout Strip (Zero Candidate Splits Leaked) */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Live Total Voter Turnout (Public Participation Telemetry)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Turnout counts stream live throughout voting while per-candidate totals stay cryptographically and rule-locked until unseal.
            </p>
          </div>
          <div className="text-right font-mono tabular-nums">
            <div className="text-2xl font-semibold text-sky-400">{turnoutStats.pct}%</div>
            <div className="text-xs text-slate-400">
              {turnoutStats.cast} of {turnoutStats.registered} registered
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-1">
          {turnoutStats.byConstituency.map((item) => (
            <div
              key={item.name}
              className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 space-y-2"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200">{item.name}</span>
                <span className="font-mono tabular-nums text-sky-400">{item.pct}%</span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sky-400"
                  style={{ width: `${Math.min(100, Number(item.pct))}%` }}
                />
              </div>
              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                {item.cast} cast / {item.reg} registered
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sealed State vs Unsealed Official Results */}
      {!canReadSealedTally ? (
        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-8 max-w-3xl mx-auto space-y-6">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-400 shrink-0">
              <Lock className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-slate-100">
                Candidate Vote Splits Are Sealed at the Database Layer
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed">
                Firestore Security Rules enforce{' '}
                <code className="font-mono text-xs text-amber-300">
                  status == &apos;closed&apos; &amp;&amp; resultsUnsealed == true &amp;&amp; isAdmin()
                </code>{' '}
                on <code className="font-mono text-xs text-slate-300">/elections/{election.id}/sealed_tallies/official</code> and all anonymized ballots.
              </p>
            </div>
          </div>

          {/* 3-Step Unlock Readiness Tracker */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 space-y-1">
              <div className="text-slate-500 font-mono">STEP 1</div>
              <div className="font-medium text-slate-200 flex items-center gap-1.5">
                {election.status === 'closed' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                )}
                Close Polls
              </div>
              <div className="text-slate-400">
                Current state: <span className="font-mono text-slate-200">{election.status}</span>
              </div>
            </div>

            <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 space-y-1">
              <div className="text-slate-500 font-mono">STEP 2</div>
              <div className="font-medium text-slate-200 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                Admin Google Re-Auth
              </div>
              <div className="text-slate-400">
                Fresh popup credential verification required
              </div>
            </div>

            <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-3.5 space-y-1">
              <div className="text-slate-500 font-mono">STEP 3</div>
              <div className="font-medium text-slate-200 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                Immutable Audit Record
              </div>
              <div className="text-slate-400">
                Atomic UNSEAL log written with Admin UID
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {isAdmin && election.status === 'active' && (
              <button
                type="button"
                disabled={closing}
                onClick={() => void handleClosePollsHere()}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-medium text-xs transition-colors cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                {closing ? 'Closing Polls…' : 'Close Polls Now'}
              </button>
            )}

            {isAdmin && election.status === 'closed' && (!election.resultsUnsealed || isUnsealPendingCommit) && (
              <button
                type="button"
                disabled={unsealing || isUnsealPendingCommit}
                onClick={() => void handleReauthAndUnseal()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
              >
                <Unlock className="w-4 h-4" />
                {isUnsealPendingCommit
                  ? 'Confirming Server Seal Release…'
                  : unsealing
                    ? 'Verifying Google Credential…'
                    : 'Re-Authenticate & Unseal Results'}
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleVerifyDbRuleLock()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-200 font-medium text-xs transition-colors cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Test Live Firestore Rule Lock
            </button>
          </div>

          {!isAdmin && (
            <p className="text-xs text-slate-400">
              You are signed in as a <strong className="text-slate-200">Polling Officer</strong>. Only an Election Administrator can close polls, re-authenticate, and view unsealed candidate tallies.
            </p>
          )}

          {ruleProbeResult.status !== 'idle' && (
            <div
              className={`rounded-lg p-3.5 border font-mono text-xs ${
                ruleProbeResult.status === 'blocked'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
              }`}
            >
              {ruleProbeResult.message}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Unsealed Certification Header */}
          <div className="bg-[#131C2E] border border-emerald-500/30 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/15 text-emerald-400 shrink-0">
                <Unlock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  Official Unsealed Election Tallies
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Unsealed by <span className="font-mono text-slate-200">{election.unsealedByEmail || 'Administrator'}</span> after Google re-authentication · Logged in immutable audit trail.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => handleExportResults('csv')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 text-xs font-medium cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" />
                Export CSV
              </button>
              <button
                type="button"
                onClick={() => handleExportResults('json')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export JSON
              </button>
            </div>
          </div>

          {/* Interactive Candidate Chart + Ranked Breakdown Table */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4 min-w-0">
              <h3 className="text-sm font-semibold text-slate-100">Candidate Vote Distribution</h3>
              <div className="h-72 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%" minHeight={260}>
                  <BarChart
                    data={candidateRows}
                    layout="vertical"
                    margin={{ top: 8, right: 24, left: 16, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" horizontal={false} />
                    <XAxis
                      type="number"
                      allowDecimals={false}
                      tick={{ fill: '#94A3B8', fontSize: 12, fontFamily: 'JetBrains Mono' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={120}
                      tick={{ fill: '#E2E8F0', fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0B1120',
                        borderColor: '#334155',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: '#F1F5F9',
                      }}
                    />
                    <Bar dataKey="votes" name="Verified Votes" radius={[0, 4, 4, 0]} maxBarSize={32}>
                      {candidateRows.map((entry) => (
                        <Cell key={entry.id} fill={entry.accentColor || '#38BDF8'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">Certified Candidate Breakdown</h3>
                <span className="font-mono text-xs text-slate-400 tabular-nums">
                  {tally?.totalTallied ?? 0} total ballots tallied
                </span>
              </div>

              <div className="divide-y divide-slate-800/80">
                {candidateRows.map((cand, idx) => (
                  <div key={cand.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-slate-500 w-5 tabular-nums">
                        #{idx + 1}
                      </span>
                      <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-700 bg-[#0B1120] shrink-0">
                        <img
                          src={resolveEmblemUrl(cand.symbolUrl, idx)}
                          alt={`${cand.party} emblem`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const img = e.currentTarget;
                            if (!img.dataset.fallbackApplied) {
                              img.dataset.fallbackApplied = '1';
                              img.src = PARTY_EMBLEM_PRESETS[idx % PARTY_EMBLEM_PRESETS.length].url;
                            }
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-slate-100">{cand.name}</div>
                        <div className="text-xs text-slate-400">
                          {cand.party} · {cand.constituency}
                        </div>
                      </div>
                    </div>

                    <div className="text-right font-mono tabular-nums">
                      <div className="text-sm font-semibold text-slate-100">{cand.votes} votes</div>
                      <div className="text-xs text-sky-400">{cand.sharePct}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
