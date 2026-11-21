import React, { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Cpu,
  Database,
  Fingerprint,
  HardDrive,
  Lock,
  Radio,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AuditLog, Election, EvmBooth, UserRole, Voter } from '../types/evm';

interface Props {
  election: Election | null;
  booths: EvmBooth[];
  voters: Voter[];
  auditLogs: AuditLog[];
  userRole: UserRole;
  gatewayConnected: boolean;
  seeding: boolean;
  onSeedSample: () => void;
  onNavigate: (tab: string) => void;
  onSelectBoothForWorkbench: (boothId: string) => void;
  onClearBoothTamper: (booth: EvmBooth) => void;
}

function classifyRssi(rssi: number): { label: string; tone: string } {
  if (rssi >= -65) return { label: 'Strong', tone: 'text-emerald-400' };
  if (rssi >= -80) return { label: 'Fair', tone: 'text-amber-400' };
  return { label: 'Weak', tone: 'text-red-400' };
}

function formatRelativeTime(ts?: { toDate?: () => Date } | null): string {
  if (!ts || typeof ts.toDate !== 'function') return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts.toDate().getTime()) / 1000));
  if (diffSec < 15) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

export const CommandMonitorView: React.FC<Props> = ({
  election,
  booths,
  voters,
  auditLogs,
  userRole,
  gatewayConnected,
  seeding,
  onSeedSample,
  onNavigate,
  onSelectBoothForWorkbench,
  onClearBoothTamper,
}) => {
  const electionBooths = useMemo(
    () => (election ? booths.filter((b) => b.electionId === election.id) : booths),
    [booths, election]
  );

  const electionVoters = useMemo(
    () => (election ? voters.filter((v) => v.electionId === election.id) : voters),
    [voters, election]
  );

  const stats = useMemo(() => {
    const registered = electionVoters.length || election?.totalRegisteredVoters || 0;
    const voted = electionVoters.filter((v) => v.hasVoted).length || election?.totalVotesCast || 0;
    const turnoutPct = registered > 0 ? ((voted / registered) * 100).toFixed(1) : '0.0';
    const onlineCount = electionBooths.filter(
      (b) => b.status === 'online' || b.status === 'degraded'
    ).length;
    const offlineCount = electionBooths.filter((b) => b.status === 'offline').length;
    const tamperedCount = electionBooths.filter((b) => b.status === 'tampered').length;
    const pendingOfflineTotal = electionBooths.reduce((sum, b) => sum + (b.pendingOfflineVotes || 0), 0);
    const pendingOfflineBytes = electionBooths.reduce((sum, b) => sum + (b.offlineQueueBytes || 0), 0);
    const enrolledCount = electionVoters.filter((v) => v.enrollmentStatus === 'enrolled').length;

    return {
      registered,
      voted,
      turnoutPct,
      onlineCount,
      offlineCount,
      tamperedCount,
      pendingOfflineTotal,
      pendingOfflineBytes,
      enrolledCount,
    };
  }, [election, electionBooths, electionVoters]);

  const constituencyTurnoutData = useMemo(() => {
    if (!election) return [];
    return election.constituencies.map((constituency) => {
      const reg = electionVoters.filter((v) => v.constituency === constituency).length;
      const cast = electionVoters.filter((v) => v.constituency === constituency && v.hasVoted).length;
      const queued = electionBooths
        .filter((b) => b.constituency === constituency)
        .reduce((sum, b) => sum + (b.pendingOfflineVotes || 0), 0);
      return {
        constituency,
        cast,
        remaining: Math.max(0, reg - cast),
        queuedOffline: queued,
        registered: reg,
        pct: reg > 0 ? Math.round((cast / reg) * 100) : 0,
      };
    });
  }, [election, electionBooths, electionVoters]);

  const recentAlerts = useMemo(
    () =>
      auditLogs
        .filter((log) => log.severity === 'critical' || log.severity === 'warning')
        .slice(0, 6),
    [auditLogs]
  );

  if (!election) {
    return (
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-10 text-center max-w-2xl mx-auto mt-8 space-y-5">
        <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center mx-auto">
          <Database className="w-6 h-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-100">No Active Election Configured</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
            Create an election in Election Management or initialize the pre-configured sample election with ESP32 polling booths, registered biometric voters, offline queue telemetry, and sealed tallies.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          {userRole === 'admin' && (
            <button
              type="button"
              onClick={onSeedSample}
              disabled={seeding}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              {seeding ? 'Seeding Sample Election…' : 'Seed Sample Election'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('elections')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 font-medium text-sm transition-colors cursor-pointer"
          >
            Configure Election Manually
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Seal Integrity Notice (Clean unboxed metadata style) */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-[#131C2E] border border-slate-800 rounded-xl px-5 py-4">
        <div className="flex items-start gap-3.5">
          <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 shrink-0 mt-0.5">
            <Lock className="w-4 h-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm font-medium text-slate-100">
              <span>{election.title}</span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span
                className={
                  election.status === 'active'
                    ? 'text-emerald-400'
                    : election.status === 'closed'
                      ? 'text-amber-400'
                      : 'text-slate-400'
                }
              >
                Polls {election.status === 'active' ? 'Open' : election.status === 'closed' ? 'Closed' : 'Draft'}
              </span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                Ballot v{election.ballotVersion}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {election.resultsUnsealed
                ? 'Candidate tallies have been unsealed following Administrator re-authentication.'
                : 'Candidate vote splits are locked at the Firestore security-rule level while live voter turnout streams in real time.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
            <Radio className={`w-3.5 h-3.5 ${gatewayConnected ? 'text-emerald-400' : 'text-amber-400'}`} />
            <span>{gatewayConnected ? 'Gateway WS Connected' : 'Gateway Reconnecting'}</span>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('results')}
            className="px-3.5 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {election.resultsUnsealed ? 'View Official Results' : 'Inspect Result Seal'}
          </button>
        </div>
      </div>

      {/* 1-Click Quick Access Strip for Simplified Topography */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          {
            tab: 'elections',
            label: 'Elections & Storage',
            sub: 'Ballots, push & delete',
            icon: SlidersHorizontal,
          },
          {
            tab: 'voters',
            label: 'Voter Biometrics',
            sub: 'Register & enroll FP',
            icon: Fingerprint,
          },
          {
            tab: 'results',
            label: 'Sealed Results',
            sub: 'Turnout & admin unseal',
            icon: Lock,
          },
          {
            tab: 'workbench',
            label: 'ESP32 Hardware',
            sub: 'API tester & firmware',
            icon: Cpu,
          },
          {
            tab: 'docs',
            label: 'Setup Docs',
            sub: 'Wiring, headers & verify',
            icon: BookOpen,
          },
          {
            tab: 'security',
            label: 'Security & Audit',
            sub: 'Logs & staff RBAC',
            icon: ShieldCheck,
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.tab}
              type="button"
              onClick={() => onNavigate(item.tab)}
              className="group bg-[#131C2E] hover:bg-[#182338] border border-slate-800 hover:border-sky-500/40 rounded-xl px-4 py-3.5 text-left transition-colors cursor-pointer flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-[#0B1120] border border-slate-800 text-sky-400 shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-100 truncate">{item.label}</div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">{item.sub}</div>
                </div>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-sky-400 shrink-0 transition-colors" />
            </button>
          );
        })}
      </div>

      {/* 4-Column Tabular KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-400">Live Voter Turnout</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="text-3xl font-semibold text-slate-100 font-mono tabular-nums">
              {stats.turnoutPct}%
            </span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              {stats.voted} / {stats.registered} voted
            </span>
          </div>
          <div className="mt-3 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-sky-400 transition-all duration-300"
              style={{ width: `${Math.min(100, Number(stats.turnoutPct))}%` }}
            />
          </div>
          <div className="mt-2.5 text-xs text-slate-400 font-mono tabular-nums">
            {stats.enrolledCount} biometric templates mapped
          </div>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-400">ESP32 Fleet Connectivity</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="text-3xl font-semibold text-slate-100 font-mono tabular-nums">
              {stats.onlineCount}
            </span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              / {electionBooths.length} booths online
            </span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <span className={stats.offlineCount > 0 ? 'text-amber-400 font-medium' : 'text-emerald-400'}>
              {stats.offlineCount} offline
            </span>
            <span aria-hidden="true">·</span>
            <span className={stats.tamperedCount > 0 ? 'text-red-400 font-medium' : 'text-slate-400'}>
              {stats.tamperedCount} tampered
            </span>
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Heartbeat SLA: 15s TLS polling / WSS push
          </div>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-400">Pending Offline Sync Queue</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span
              className={`text-3xl font-semibold font-mono tabular-nums ${
                stats.pendingOfflineTotal > 0 ? 'text-amber-400' : 'text-slate-100'
              }`}
            >
              {stats.pendingOfflineTotal}
            </span>
            <span className="text-xs text-slate-400">queued ballots</span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <HardDrive className="w-3.5 h-3.5 text-slate-500" />
            <span>{stats.pendingOfflineBytes} B in ESP32 LittleFS</span>
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Auto-flushes with conflict checks on reconnect
          </div>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-400">Security & Tamper Alerts</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span
              className={`text-3xl font-semibold font-mono tabular-nums ${
                stats.tamperedCount > 0 ? 'text-red-400' : 'text-emerald-400'
              }`}
            >
              {recentAlerts.filter((a) => a.severity === 'critical').length}
            </span>
            <span className="text-xs text-slate-400">critical events logged</span>
          </div>
          <div className="mt-3 text-xs text-slate-400">
            {stats.tamperedCount > 0
              ? `${stats.tamperedCount} booth(s) locked pending officer clearance`
              : 'All chassis reed switches & biometric seals nominal'}
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Immutable append-only Firestore audit ledger
          </div>
        </div>
      </div>

      {/* Main Split: Constituency Turnout Chart + Recent Security/Offline Events */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-[#131C2E] border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Live Constituency Turnout (Sealed Candidate Splits)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time verified participation and offline booth queue counts without revealing candidate tallies.
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-sky-400" />
                Synced Votes
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-400" />
                Offline Queued
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-slate-700" />
                Not Yet Voted
              </span>
            </div>
          </div>

          <div className="h-64 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%" minHeight={240}>
              <BarChart
                data={constituencyTurnoutData}
                margin={{ top: 10, right: 16, left: -12, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
                <XAxis
                  dataKey="constituency"
                  tick={{ fill: '#94A3B8', fontSize: 12 }}
                  axisLine={{ stroke: 'rgba(148,163,184,0.2)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#94A3B8', fontSize: 12, fontFamily: 'JetBrains Mono' }}
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
                <Bar dataKey="cast" name="Synced Votes Cast" stackId="a" fill="#38BDF8" radius={[0, 0, 0, 0]} maxBarSize={56} />
                <Bar dataKey="queuedOffline" name="Pending Offline Queue" stackId="a" fill="#F59E0B" maxBarSize={56} />
                <Bar dataKey="remaining" name="Remaining Registered" stackId="a" fill="#1E293B" radius={[4, 4, 0, 0]} maxBarSize={56} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h2 className="text-base font-semibold text-slate-100">Active Alerts & Sync Events</h2>
            <button
              type="button"
              onClick={() => onNavigate('security')}
              className="text-xs text-sky-400 hover:text-sky-300 font-medium cursor-pointer"
            >
              Full Ledger
            </button>
          </div>

          <div className="divide-y divide-slate-800/80 flex-1 overflow-y-auto mt-1">
            {recentAlerts.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto" />
                <p className="text-sm text-slate-300">No tamper or conflict warnings</p>
                <p className="text-xs text-slate-500">All booths operating within nominal thresholds.</p>
              </div>
            ) : (
              recentAlerts.map((log) => (
                <div key={log.id} className="py-3 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span
                      className={`font-medium flex items-center gap-1.5 ${
                        log.severity === 'critical' ? 'text-red-400' : 'text-amber-400'
                      }`}
                    >
                      {log.severity === 'critical' ? (
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      )}
                      {log.action.replace(/_/g, ' ')}
                    </span>
                    <span className="font-mono text-slate-500 tabular-nums shrink-0">
                      {formatRelativeTime(log.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{log.summary}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Live ESP32 Booth Health & Offline Queue Table */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              ESP32 Booth Health & Offline Sync Status
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Real-time Wi-Fi RSSI, sync latency, local LittleFS offline ballot queues, and hardware tamper state.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('workbench')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-slate-100 text-xs font-medium transition-colors cursor-pointer"
          >
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            Open ESP32 Workbench
          </button>
        </div>

        {/* Mobile Stacked Booth Cards */}
        <div className="md:hidden divide-y divide-slate-800/80">
          {electionBooths.length === 0 ? (
            <div className="py-10 px-4 text-center text-slate-400 text-xs">
              No ESP32 polling booths provisioned for this election yet.
            </div>
          ) : (
            electionBooths.map((booth) => {
              const rssiInfo = classifyRssi(booth.wifiRssi);
              const isOffline = booth.status === 'offline';
              const isTampered = booth.status === 'tampered';
              return (
                <div key={booth.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-sky-400">{booth.boothCode}</span>
                        <span className="text-sm font-medium text-slate-100 truncate">{booth.name}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {booth.constituency} · Ballot v{booth.ballotVersion} · Battery {booth.batteryPct}%
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-1.5 font-medium">
                      {isTampered ? (
                        <>
                          <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="text-red-400">Tamper Lockout</span>
                        </>
                      ) : isOffline ? (
                        <>
                          <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="text-amber-400">Offline · Queue Active</span>
                        </>
                      ) : booth.status === 'degraded' ? (
                        <>
                          <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="text-amber-400">Degraded Signal</span>
                        </>
                      ) : (
                        <>
                          <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span className="text-emerald-400">Online · Synced</span>
                        </>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-slate-500">
                      {formatRelativeTime(booth.lastHeartbeatAt)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 bg-[#0B1120] border border-slate-800 rounded-lg p-2.5 text-xs font-mono tabular-nums">
                    <div>
                      <div className="text-[10px] text-slate-500">RSSI</div>
                      <div className={isOffline ? 'text-slate-500' : rssiInfo.tone}>
                        {isOffline ? 'No link' : `${booth.wifiRssi} dBm`}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">LATENCY</div>
                      <div className="text-slate-200">{isOffline ? '—' : `${booth.syncLatencyMs} ms`}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">VOTES</div>
                      <div className="text-slate-200">
                        {booth.votesCast}
                        {booth.pendingOfflineVotes > 0 && (
                          <span className="text-amber-400"> (+{booth.pendingOfflineVotes})</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="bg-[#08121E] border border-slate-700/80 rounded px-2.5 py-1 font-mono text-[11px] text-sky-300 truncate max-w-full">
                      {booth.lcdMessage}
                    </div>
                    <div className="flex items-center gap-2 ml-auto">
                      {isTampered && userRole === 'admin' && (
                        <button
                          type="button"
                          onClick={() => onClearBoothTamper(booth)}
                          className="px-3 py-1.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-xs font-medium cursor-pointer"
                        >
                          Clear Tamper
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectBoothForWorkbench(booth.id)}
                        className="px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] text-slate-100 text-xs font-medium cursor-pointer"
                      >
                        Test / Sync
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop 7-Column Telemetry Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-[#0F172A]/70 text-xs text-slate-400">
                <th className="py-3 px-4 font-medium">Booth / Constituency</th>
                <th className="py-3 px-4 font-medium">Link & Sync State</th>
                <th className="py-3 px-4 font-medium text-right">Wi-Fi RSSI</th>
                <th className="py-3 px-4 font-medium text-right">Latency</th>
                <th className="py-3 px-4 font-medium text-right">Synced / Offline Queue</th>
                <th className="py-3 px-4 font-medium">ESP32 LCD Readout</th>
                <th className="py-3 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-sm">
              {electionBooths.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400 text-sm">
                    No ESP32 polling booths provisioned for this election yet.
                  </td>
                </tr>
              ) : (
                electionBooths.map((booth) => {
                  const rssiInfo = classifyRssi(booth.wifiRssi);
                  const isOffline = booth.status === 'offline';
                  const isTampered = booth.status === 'tampered';

                  return (
                    <tr key={booth.id} className="hover:bg-slate-800/35 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-100 flex items-center gap-2">
                          <span className="font-mono text-xs text-sky-400">{booth.boothCode}</span>
                          <span>{booth.name}</span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {booth.constituency} · Ballot v{booth.ballotVersion} · Battery {booth.batteryPct}%
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          {isTampered ? (
                            <>
                              <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                              <span className="text-red-400">Tamper Lockout</span>
                            </>
                          ) : isOffline ? (
                            <>
                              <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <span className="text-amber-400">Offline · Local Queue Active</span>
                            </>
                          ) : booth.status === 'degraded' ? (
                            <>
                              <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <span className="text-amber-400">Degraded Signal</span>
                            </>
                          ) : (
                            <>
                              <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              <span className="text-emerald-400">Online · Synced</span>
                            </>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                          {booth.syncState === 'conflict_alert'
                            ? `Conflict alert (${booth.localConflictCount || 0} rejected)`
                            : `Heartbeat ${formatRelativeTime(booth.lastHeartbeatAt)}`}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs">
                        {isOffline ? (
                          <span className="text-slate-500">No link</span>
                        ) : (
                          <div>
                            <span className="text-slate-200">{booth.wifiRssi} dBm</span>
                            <div className={`text-[11px] ${rssiInfo.tone}`}>{rssiInfo.label}</div>
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-300">
                        {isOffline ? '—' : `${booth.syncLatencyMs} ms`}
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs">
                        <div className="text-slate-200">{booth.votesCast} synced</div>
                        {booth.pendingOfflineVotes > 0 ? (
                          <div className="text-amber-400 font-medium">
                            +{booth.pendingOfflineVotes} queued ({booth.offlineQueueBytes} B)
                          </div>
                        ) : (
                          <div className="text-slate-500">0 pending</div>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="inline-block bg-[#08121E] border border-slate-700/80 rounded px-2.5 py-1 font-mono text-[11px] text-sky-300 tracking-wide">
                          {booth.lcdMessage}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="inline-flex items-center gap-2">
                          {isTampered && userRole === 'admin' && (
                            <button
                              type="button"
                              onClick={() => onClearBoothTamper(booth)}
                              className="px-2.5 py-1.5 rounded-md bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                            >
                              Clear Tamper
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onSelectBoothForWorkbench(booth.id)}
                            className="px-2.5 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
                          >
                            Test / Sync
                          </button>
                        </div>
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
  );
};
