import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileCheck2,
  Info,
  Search,
  Shield,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { updateStaffMemberRole } from '../lib/firestoreService';
import type { AuditCategory, AuditLog, UserProfile, UserRole } from '../types/evm';

interface Props {
  auditLogs: AuditLog[];
  staffUsers: UserProfile[];
  currentUserProfile: UserProfile | null;
  mode?: 'audit' | 'access';
  onNotify: (msg: string, tone?: 'info' | 'success' | 'error') => void;
}

export const AuditAndAccessView: React.FC<Props> = ({
  auditLogs,
  staffUsers,
  currentUserProfile,
  mode = 'audit',
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<'audit' | 'access'>(mode);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | AuditCategory>('ALL');
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return auditLogs.filter((log) => {
      if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        log.action.toLowerCase().includes(q) ||
        log.summary.toLowerCase().includes(q) ||
        log.actorEmail.toLowerCase().includes(q)
      );
    });
  }, [auditLogs, search, categoryFilter]);

  const handleExportAuditJson = () => {
    const payload = filteredLogs.map((l) => ({
      id: l.id,
      timestamp: l.createdAt?.toDate ? l.createdAt.toDate().toISOString() : null,
      category: l.category,
      severity: l.severity,
      action: l.action,
      actorEmail: l.actorEmail,
      actorRole: l.actorRole,
      boothId: l.boothId || null,
      electionId: l.electionId || null,
      summary: l.summary,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-vote-audit-trail-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleChangeRole = async (target: UserProfile, role: UserRole) => {
    if (target.uid === currentUserProfile?.uid) {
      onNotify('You cannot demote your own active Administrator session.', 'error');
      return;
    }
    setUpdatingUid(target.uid);
    try {
      await updateStaffMemberRole(target, role);
      onNotify(`Updated ${target.email} to ${role === 'admin' ? 'Election Administrator' : 'Polling Officer'}.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Role update denied.', 'error');
    } finally {
      setUpdatingUid(null);
    }
  };

  const subTabBar = (
    <div className="flex sm:inline-flex items-center gap-1 p-1 rounded-xl bg-[#131C2E] border border-slate-800 w-full sm:w-auto">
      <button
        type="button"
        onClick={() => setSubTab('audit')}
        className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
          subTab === 'audit'
            ? 'bg-sky-500 text-slate-950'
            : 'text-slate-400 hover:text-slate-100'
        }`}
      >
        <FileCheck2 className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">Audit Trail ({auditLogs.length})</span>
      </button>
      <button
        type="button"
        onClick={() => setSubTab('access')}
        className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
          subTab === 'access'
            ? 'bg-sky-500 text-slate-950'
            : 'text-slate-400 hover:text-slate-100'
        }`}
      >
        <Users className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">Access ({staffUsers.length})</span>
      </button>
    </div>
  );

  if (subTab === 'access') {
    const isAdmin = currentUserProfile?.role === 'admin';
    return (
      <div className="space-y-6">
        {subTabBar}
        <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Role-Based Access Control (RBAC) Directory
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Election Administrators hold full lifecycle and result-unseal authority; Polling Officers are scoped to voter enrollment and booth monitoring.
              </p>
            </div>
          </div>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {staffUsers.length} registered operator{staffUsers.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
          {/* Mobile Staff Cards */}
          <div className="md:hidden divide-y divide-slate-800/80">
            {staffUsers.map((u) => (
              <div key={u.uid} className="p-4 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-slate-100 truncate">
                      {u.displayName}
                      {u.uid === currentUserProfile?.uid && (
                        <span className="ml-1.5 text-xs font-mono text-sky-400">(You)</span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-slate-400 truncate">{u.email}</div>
                  </div>
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      u.role === 'admin' ? 'text-sky-400' : 'text-slate-300'
                    }`}
                  >
                    {u.role === 'admin' ? 'Admin' : 'Officer'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-400">
                    {u.assignedConstituency || 'All Constituencies'}
                  </span>
                  {isAdmin &&
                    (u.uid === currentUserProfile?.uid ? (
                      <span className="font-mono text-slate-500">Protected Self</span>
                    ) : (
                      <button
                        type="button"
                        disabled={updatingUid === u.uid}
                        onClick={() =>
                          void handleChangeRole(u, u.role === 'admin' ? 'officer' : 'admin')
                        }
                        className="px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] text-xs text-slate-200 font-medium cursor-pointer"
                      >
                        {updatingUid === u.uid
                          ? 'Updating…'
                          : u.role === 'admin'
                            ? 'Demote to Officer'
                            : 'Promote to Admin'}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Staff Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0F172A]/70 text-xs text-slate-400">
                  <th className="py-3 px-4 font-medium">Operator</th>
                  <th className="py-3 px-4 font-medium">Role Scope</th>
                  <th className="py-3 px-4 font-medium">Assigned Jurisdiction</th>
                  {isAdmin && <th className="py-3 px-4 font-medium text-right">Role Assignment</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {staffUsers.map((u) => (
                  <tr key={u.uid} className="hover:bg-slate-800/35">
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-100">
                        {u.displayName}
                        {u.uid === currentUserProfile?.uid && (
                          <span className="ml-2 text-xs font-mono text-sky-400">(You)</span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-slate-400">{u.email}</div>
                    </td>
                    <td className="py-3.5 px-4 text-xs">
                      <span
                        className={`font-medium ${
                          u.role === 'admin' ? 'text-sky-400' : 'text-slate-300'
                        }`}
                      >
                        {u.role === 'admin' ? 'Election Administrator' : 'Polling Officer'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">
                      {u.assignedConstituency || 'All Constituencies'}
                    </td>
                    {isAdmin && (
                      <td className="py-3.5 px-4 text-right">
                        {u.uid === currentUserProfile?.uid ? (
                          <span className="font-mono text-xs text-slate-500">Protected Self</span>
                        ) : (
                          <button
                            type="button"
                            disabled={updatingUid === u.uid}
                            onClick={() =>
                              void handleChangeRole(u, u.role === 'admin' ? 'officer' : 'admin')
                            }
                            className="px-3 py-1.5 rounded-md border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-xs text-slate-200 font-medium cursor-pointer"
                          >
                            {updatingUid === u.uid
                              ? 'Updating…'
                              : u.role === 'admin'
                                ? 'Demote to Officer'
                                : 'Promote to Admin'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {subTabBar}
      {/* Audit Filter Bar */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter immutable audit ledger by action, email, or summary…"
            className="w-full bg-[#0B1120] border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center p-1 bg-[#0B1120] border border-slate-800 rounded-lg overflow-x-auto">
            {(['ALL', 'ADMIN', 'OFFICER', 'ESP32', 'OFFLINE_SYNC', 'SECURITY', 'UNSEAL'] as const).map(
              (cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-colors whitespace-nowrap cursor-pointer ${
                    categoryFilter === cat
                      ? 'bg-[#1B2740] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat}
                </button>
              )
            )}
          </div>

          <button
            type="button"
            onClick={handleExportAuditJson}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-700 bg-[#1B2740] hover:bg-slate-800 text-xs font-medium text-slate-100 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            Export JSON
          </button>
        </div>
      </div>

      {/* Immutable Audit Trail Table */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-2">
            <FileCheck2 className="w-4 h-4 text-emerald-400" />
            Append-Only Audit Trail (<code className="font-mono text-slate-300">update: false, delete: false</code>)
          </span>
          <span className="font-mono tabular-nums">{filteredLogs.length} events</span>
        </div>

        {/* Mobile Stacked Audit Cards */}
        <div className="md:hidden divide-y divide-slate-800/80">
          {filteredLogs.length === 0 ? (
            <div className="py-10 px-4 text-center text-xs text-slate-400">
              No audit entries match the current filter.
            </div>
          ) : (
            filteredLogs.map((log) => (
              <div key={log.id} className="p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-mono">
                    {log.severity === 'critical' ? (
                      <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    ) : log.severity === 'warning' ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    ) : (
                      <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    )}
                    <span
                      className={
                        log.severity === 'critical'
                          ? 'text-red-400 font-semibold'
                          : log.severity === 'warning'
                            ? 'text-amber-300'
                            : 'text-sky-300'
                      }
                    >
                      {log.category}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    {log.createdAt?.toDate ? log.createdAt.toDate().toLocaleString() : 'Pending…'}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-400">{log.action}</div>
                <p className="text-slate-200 leading-relaxed">{log.summary}</p>
                <div className="text-[11px] font-mono text-slate-500 flex items-center gap-2">
                  <span className="truncate">{log.actorEmail}</span>
                  <span>·</span>
                  <span className="capitalize shrink-0">{log.actorRole}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Desktop 4-Column Audit Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-[#0F172A]/70 text-xs text-slate-400">
                <th className="py-3 px-4 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Category & Action</th>
                <th className="py-3 px-4 font-medium">Actor</th>
                <th className="py-3 px-4 font-medium">Event Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-slate-400">
                    No audit entries match the current filter.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/35">
                    <td className="py-3 px-4 font-mono text-slate-400 tabular-nums whitespace-nowrap">
                      {log.createdAt?.toDate ? log.createdAt.toDate().toLocaleString() : 'Pending…'}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-mono">
                        {log.severity === 'critical' ? (
                          <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        ) : log.severity === 'warning' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        )}
                        <span
                          className={
                            log.severity === 'critical'
                              ? 'text-red-400 font-semibold'
                              : log.severity === 'warning'
                                ? 'text-amber-300'
                                : 'text-sky-300'
                          }
                        >
                          {log.category}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 mt-0.5">{log.action}</div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="text-slate-200 font-mono">{log.actorEmail}</div>
                      <div className="text-[11px] text-slate-500 capitalize flex items-center gap-1">
                        <Shield className="w-3 h-3" />
                        {log.actorRole}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-300 leading-relaxed max-w-xl">
                      {log.summary}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
