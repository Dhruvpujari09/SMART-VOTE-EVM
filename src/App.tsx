import React, { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import {
  Activity,
  BookOpen,
  CheckCircle2,
  Cpu,
  Fingerprint,
  Lock,
  LogOut,
  Menu,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { AuditAndAccessView } from './components/AuditAndAccessView';
import { CommandMonitorView } from './components/CommandMonitorView';
import { ElectionManagementView } from './components/ElectionManagementView';
import { Esp32SetupDocsView } from './components/Esp32SetupDocsView';
import { Esp32WorkbenchView } from './components/Esp32WorkbenchView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAControls';
import { SealedResultsView } from './components/SealedResultsView';
import { SmartVoteLogo } from './components/SmartVoteLogo';
import { VoterRegistryView } from './components/VoterRegistryView';
import { useGatewaySocket } from './hooks/useGatewaySocket';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from './lib/firebase';
import {
  appendAuditLog,
  ensureUserProfile,
  seedSampleElection,
  updateBoothTelemetry,
} from './lib/firestoreService';
import type {
  AuditLog,
  Candidate,
  Election,
  EvmBooth,
  UserProfile,
  Voter,
} from './types/evm';

type NavTab = 'monitor' | 'elections' | 'voters' | 'results' | 'workbench' | 'docs' | 'security';

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'monitor', label: 'Overview', hint: 'Live telemetry & quick actions', icon: Activity },
  { id: 'elections', label: 'Elections', hint: 'Ballots, validation & cleanup', icon: SlidersHorizontal },
  { id: 'voters', label: 'Voters', hint: 'Registry & biometrics', icon: Fingerprint },
  { id: 'results', label: 'Results', hint: 'Turnout & sealed tallies', icon: Lock },
  { id: 'workbench', label: 'ESP32 Hardware', hint: 'Live API, offline sync & code', icon: Cpu },
  { id: 'docs', label: 'Setup Docs', hint: 'Wiring, headers & live checks', icon: BookOpen },
  { id: 'security', label: 'Security & Audit', hint: 'Audit ledger & staff roles', icon: ShieldCheck },
];

export default function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const [activeTab, setActiveTab] = useState<NavTab>('monitor');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedElectionId, setSelectedElectionId] = useState<string>('');
  const [workbenchBoothId, setWorkbenchBoothId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  // Authoritative Firestore real-time collections
  const [elections, setElections] = useState<Election[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [booths, setBooths] = useState<EvmBooth[]>([]);
  const [voters, setVoters] = useState<Voter[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [staffUsers, setStaffUsers] = useState<UserProfile[]>([]);

  // Toast notification state
  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'success' | 'error' } | null>(null);

  const showToast = (msg: string, tone: 'info' | 'success' | 'error' = 'info') => {
    setToast({ msg, tone });
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // 1. Firebase Authentication Lifecycle
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        try {
          const profile = await ensureUserProfile(user);
          setUserProfile(profile);
        } catch (err) {
          console.error('Failed to load operator profile:', err);
          setUserProfile(null);
        }
      } else {
        setUserProfile(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const dataListenersEnabled = Boolean(authReady && firebaseUser && userProfile);
  const { connected: gatewayConnected, events: gatewayEvents } = useGatewaySocket(dataListenersEnabled);

  // 2. Real-Time Firestore Listeners (Mounted ONLY when authenticated & profile ready)
  useEffect(() => {
    if (!dataListenersEnabled || !userProfile) return;

    const unsubElections = onSnapshot(
      query(collection(db, 'elections'), orderBy('createdAt', 'desc')),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Election, 'id'>) }));
        setElections(list);
        setSelectedElectionId((prev) =>
          prev && list.some((e) => e.id === prev) ? prev : list[0]?.id || ''
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'elections')
    );

    const unsubBooths = onSnapshot(
      collection(db, 'booths'),
      (snap) => {
        setBooths(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EvmBooth, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'booths')
    );

    const unsubVoters = onSnapshot(
      collection(db, 'voters'),
      (snap) => {
        setVoters(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Voter, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'voters')
    );

    const unsubLogs = onSnapshot(
      query(collection(db, 'audit_logs'), orderBy('createdAt', 'desc')),
      (snap) => {
        setAuditLogs(
          snap.docs.slice(0, 120).map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'audit_logs')
    );

    const usersQuery =
      userProfile.role === 'admin'
        ? collection(db, 'users')
        : query(collection(db, 'users'), where('uid', '==', userProfile.uid));

    const unsubUsers = onSnapshot(
      usersQuery,
      (snap) => {
        setStaffUsers(snap.docs.map((d) => d.data() as UserProfile));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'users')
    );

    return () => {
      unsubElections();
      unsubBooths();
      unsubVoters();
      unsubLogs();
      unsubUsers();
    };
  }, [dataListenersEnabled, userProfile]);

  // Subscribe to candidates for selected election
  useEffect(() => {
    if (!dataListenersEnabled || !selectedElectionId) {
      setCandidates([]);
      return;
    }
    const path = `elections/${selectedElectionId}/candidates`;
    const unsub = onSnapshot(
      collection(db, 'elections', selectedElectionId, 'candidates'),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Candidate, 'id'>) }))
          .sort((a, b) => a.ballotNumber - b.ballotNumber);
        setCandidates(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, path)
    );
    return () => unsub();
  }, [dataListenersEnabled, selectedElectionId]);

  const selectedElection = useMemo(
    () => elections.find((e) => e.id === selectedElectionId) || elections[0] || null,
    [elections, selectedElectionId]
  );

  // Sync live Firestore booths, ballot manifests, and voter eligibility cache into the Express ESP32 Gateway
  useEffect(() => {
    if (!dataListenersEnabled) return;
    const payload = {
      authoritative: true,
      booths: booths.map((b) => ({
        boothId: b.id,
        boothCode: b.boothCode,
        electionId: b.electionId,
        constituency: b.constituency,
        apiKeyHash: b.apiKeyHash,
        status: b.status,
        syncState: b.syncState,
        wifiRssi: b.wifiRssi,
        syncLatencyMs: b.syncLatencyMs,
        batteryPct: b.batteryPct,
        firmwareVersion: b.firmwareVersion,
        ballotVersion: b.ballotVersion,
        pendingOfflineVotes: b.pendingOfflineVotes,
        offlineQueueBytes: b.offlineQueueBytes,
        tamperState: b.tamperState,
        lcdMessage: b.lcdMessage,
      })),
      ballots: selectedElection
        ? [
            {
              electionId: selectedElection.id,
              title: selectedElection.title,
              status: selectedElection.status,
              ballotVersion: selectedElection.ballotVersion,
              ballotHash: selectedElection.ballotHash,
              candidates: candidates.map((c) => ({
                id: c.id,
                ballotNumber: c.ballotNumber,
                name: c.name,
                party: c.party,
                constituency: c.constituency,
              })),
            },
          ]
        : [],
      voters: voters.map((v) => ({
        voterDocId: v.id,
        electionId: v.electionId,
        constituency: v.constituency,
        fingerprintTemplateId: v.fingerprintTemplateId || null,
        hasVoted: v.hasVoted,
        votedBoothId: v.votedBoothId || null,
      })),
    };

    void fetch('/api/gateway/sync-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }, [dataListenersEnabled, booths, candidates, selectedElection, voters]);

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Google sign-in failed.', 'error');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSeedSampleElection = async () => {
    if (userProfile?.role !== 'admin') return;
    setSeeding(true);
    try {
      const id = await seedSampleElection();
      setSelectedElectionId(id);
      showToast('Sample election seeded with 4 candidates, 4 ESP32 booths (1 offline), 12 voters, and sealed tallies.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to seed sample election.', 'error');
    } finally {
      setSeeding(false);
    }
  };

  const handleClearBoothTamper = async (booth: EvmBooth) => {
    try {
      await updateBoothTelemetry(booth.id, {
        status: 'online',
        tamperState: 'nominal',
        lcdMessage: 'READY - PLACE FINGER',
      });
      await appendAuditLog({
        category: 'ADMIN',
        action: 'TAMPER_CLEARED_BY_ADMIN',
        severity: 'warning',
        actorRole: 'admin',
        boothId: booth.id,
        electionId: booth.electionId,
        summary: `Administrator inspected and cleared hardware tamper lockout on ${booth.boothCode}.`,
      });
      showToast(`Cleared tamper seal lockout on ${booth.boothCode}.`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to clear tamper alert.', 'error');
    }
  };

  // Loading Splash
  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#0B1120] flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center mx-auto">
            <Shield className="w-5 h-5 text-sky-400" />
          </div>
          <p className="text-xs font-mono text-slate-400">Initializing Smart Vote Secure Console…</p>
        </div>
      </div>
    );
  }

  // Unauthenticated Mission-Control Sign-In Screen
  if (!firebaseUser || !userProfile) {
    return (
      <div className="min-h-screen bg-[#0B1120] text-[#F1F5F9] flex flex-col justify-between p-6">
        <div className="max-w-5xl w-full mx-auto flex items-center justify-between py-2">
          <SmartVoteLogo size="lg" showSubtitle />
          <PWAInstallButton />
        </div>

        <main className="max-w-4xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-center my-auto py-8">
          <div className="lg:col-span-7 space-y-5">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-100 leading-tight">
              ESP32 Biometric Voting Command &amp; Audit Console
            </h1>
            <p className="text-sm sm:text-base text-slate-400 leading-relaxed max-w-xl">
              Manage elections, validate ballot configurations prior to hardware push, map opaque R307/AS608 fingerprint template IDs, monitor offline ESP32 queues, and enforce database-level tally sealing until polls close.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-xs text-slate-300">
              <div className="bg-[#131C2E] border border-slate-800 rounded-lg p-3.5 space-y-1">
                <div className="font-semibold text-slate-100">Database-Locked Tallies</div>
                <p className="text-slate-400">
                  Candidate splits are denied by Firestore rules until polls close and an Admin re-authenticates.
                </p>
              </div>
              <div className="bg-[#131C2E] border border-slate-800 rounded-lg p-3.5 space-y-1">
                <div className="font-semibold text-slate-100">Zero Raw Biometrics</div>
                <p className="text-slate-400">
                  Only opaque ESP32 template IDs are synced; anonymized cast ballots never reference voter IDs.
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-slate-100">Operator Sign-In</h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Authenticate with verified Google credentials. Access is automatically scoped to your Election Administrator or Polling Officer role.
              </p>
            </div>

            <button
              type="button"
              disabled={signingIn}
              onClick={() => void handleGoogleSignIn()}
              className="w-full py-3 px-4 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
            >
              {signingIn ? 'Authenticating…' : 'Sign in with Google'}
            </button>

            <div className="border-t border-slate-800 pt-4 text-[11px] text-slate-500 space-y-1">
              <div>Election Administrators: Full ballot, booth, close-poll &amp; unseal control</div>
              <div>Polling Officers: Voter registration, biometric enrollment &amp; live monitoring</div>
            </div>
          </div>
        </main>

        <footer className="max-w-5xl w-full mx-auto py-3 text-xs text-slate-500 flex items-center justify-between">
          <span>Smart Vote · ESP32 Fingerprint EVM Operations PWA</span>
          <span className="font-mono">TLS + Zero-Trust Firestore RBAC</span>
        </footer>

        <OfflineIndicator />
      </div>
    );
  }

  const currentNav = NAV_ITEMS.find((i) => i.id === activeTab) || NAV_ITEMS[0];

  return (
    <div className="min-h-screen bg-[#0B1120] text-[#F1F5F9] flex">
      {/* Desktop Sidebar (272px) */}
      <aside className="hidden lg:flex lg:flex-col w-[272px] shrink-0 bg-[#0F172A] border-r border-slate-800/90 sticky top-0 h-screen">
        <div className="h-20 px-5 flex items-center border-b border-slate-800/90">
          <SmartVoteLogo size="md" showSubtitle />
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto" aria-label="Primary Console Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1B2740] text-slate-50 border border-sky-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-sky-400' : 'text-slate-500'}`} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate leading-tight">{item.label}</div>
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">{item.hint}</div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Admin Quick Sample Seed & Operator Footer */}
        <div className="p-4 border-t border-slate-800/90 space-y-3">
          {userProfile.role === 'admin' && (
            <button
              type="button"
              disabled={seeding}
              onClick={() => void handleSeedSampleElection()}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-[#131C2E] hover:bg-[#1B2740] text-xs font-medium text-slate-200 transition-colors cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
              {seeding ? 'Seeding Data…' : 'Seed Sample Election'}
            </button>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-200 truncate">
                {userProfile.displayName}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {userProfile.role === 'admin' ? 'Election Admin' : 'Polling Officer'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void signOut(auth)}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-72 max-w-[85vw] bg-[#0F172A] border-r border-slate-800 flex flex-col z-10">
            <div className="h-18 px-4 py-3 flex items-center justify-between border-b border-slate-800">
              <SmartVoteLogo size="sm" />
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-sm font-medium cursor-pointer ${
                      active ? 'bg-[#1B2740] text-slate-100 border border-sky-500/30' : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-sky-400' : 'text-slate-500'}`} />
                    <div>
                      <div>{item.label}</div>
                      <div className="text-[11px] text-slate-500 font-normal">{item.hint}</div>
                    </div>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-800 space-y-3">
              {userProfile.role === 'admin' && (
                <button
                  type="button"
                  disabled={seeding}
                  onClick={() => {
                    setMobileNavOpen(false);
                    void handleSeedSampleElection();
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-slate-700 bg-[#131C2E] hover:bg-[#1B2740] text-xs font-medium text-slate-200 transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                  {seeding ? 'Seeding Data…' : 'Seed Sample Election'}
                </button>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-200 truncate">
                    {userProfile.displayName}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">{userProfile.email}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void signOut(auth)}
                  className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Workspace */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Adaptive Top Bar (Compact on Mobile, Spacious Single-Row on Desktop) */}
        <header className="sticky top-0 z-30 bg-[#0B1120]/95 backdrop-blur-sm border-b border-slate-800/90">
          <div className="h-14 lg:h-16 px-3 sm:px-4 lg:px-6 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden p-2 -ml-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 shrink-0"
                aria-label="Open navigation menu"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="lg:hidden min-w-0">
                <SmartVoteLogo size="sm" />
              </div>
              <div className="hidden lg:flex items-center gap-2.5 min-w-0">
                <h1 className="text-base font-bold text-slate-100 truncate">{currentNav.label}</h1>
                <span className="text-slate-600" aria-hidden="true">·</span>
                <span className="text-xs text-slate-400 truncate">{currentNav.hint}</span>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {elections.length > 0 && (
                <select
                  aria-label="Active Election"
                  value={selectedElection?.id || ''}
                  onChange={(e) => setSelectedElectionId(e.target.value)}
                  className="hidden md:block max-w-[260px] truncate bg-[#131C2E] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-400"
                >
                  {elections.map((el) => (
                    <option key={el.id} value={el.id}>
                      {el.title} ({el.status})
                    </option>
                  ))}
                </select>
              )}
              <PWAInstallButton />
            </div>
          </div>

          {/* Dedicated Full-Width Mobile Election Picker (prevents top bar crowding on narrow phones) */}
          {elections.length > 0 && (
            <div className="md:hidden px-3 pb-2.5 flex items-center gap-2">
              <span className="text-[11px] font-mono text-slate-500 uppercase shrink-0">Election:</span>
              <select
                aria-label="Active Election Mobile"
                value={selectedElection?.id || ''}
                onChange={(e) => setSelectedElectionId(e.target.value)}
                className="flex-1 min-w-0 bg-[#131C2E] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-400"
              >
                {elections.map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.title} ({el.status})
                  </option>
                ))}
              </select>
            </div>
          )}
        </header>

        {/* Main Scrolling Viewport (Extra bottom padding on mobile for fixed bottom tab bar) */}
        <main className="flex-1 p-3 sm:p-4 lg:p-6 pb-24 lg:pb-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'monitor' && (
            <CommandMonitorView
              election={selectedElection}
              booths={booths}
              voters={voters}
              auditLogs={auditLogs}
              userRole={userProfile.role}
              gatewayConnected={gatewayConnected}
              seeding={seeding}
              onSeedSample={() => void handleSeedSampleElection()}
              onNavigate={(tab) => setActiveTab(tab as NavTab)}
              onSelectBoothForWorkbench={(boothId) => {
                setWorkbenchBoothId(boothId);
                setActiveTab('workbench');
              }}
              onClearBoothTamper={(booth) => void handleClearBoothTamper(booth)}
            />
          )}

          {activeTab === 'elections' && (
            <ElectionManagementView
              elections={elections}
              selectedElection={selectedElection}
              onSelectElection={(id) => setSelectedElectionId(id)}
              candidates={candidates}
              booths={booths}
              userRole={userProfile.role}
              onNotify={showToast}
            />
          )}

          {activeTab === 'voters' && (
            <VoterRegistryView
              election={selectedElection}
              voters={voters}
              booths={booths}
              userRole={userProfile.role}
              onNotify={showToast}
            />
          )}

          {activeTab === 'results' && (
            <SealedResultsView
              election={selectedElection}
              candidates={candidates}
              booths={booths}
              voters={voters}
              userRole={userProfile.role}
              onNotify={showToast}
            />
          )}

          {activeTab === 'workbench' && (
            <Esp32WorkbenchView
              election={selectedElection}
              booths={booths}
              candidates={candidates}
              voters={voters}
              userRole={userProfile.role}
              initialBoothId={workbenchBoothId}
              gatewayConnected={gatewayConnected}
              gatewayEvents={gatewayEvents}
              onOpenDocs={() => setActiveTab('docs')}
              onNotify={showToast}
            />
          )}

          {activeTab === 'docs' && (
            <Esp32SetupDocsView
              election={selectedElection}
              booths={booths}
              gatewayConnected={gatewayConnected}
              onOpenHardwareTab={(boothId) => {
                if (boothId) setWorkbenchBoothId(boothId);
                setActiveTab('workbench');
              }}
              onNavigate={(tab) => setActiveTab(tab as NavTab)}
            />
          )}

          {activeTab === 'security' && (
            <AuditAndAccessView
              auditLogs={auditLogs}
              staffUsers={staffUsers}
              currentUserProfile={userProfile}
              onNotify={showToast}
            />
          )}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (Thumb-Friendly Primary Access) */}
      <nav
        aria-label="Mobile Quick Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0F172A]/95 backdrop-blur-md border-t border-slate-800 pb-safe"
      >
        <div className="grid grid-cols-6 h-16">
          {[
            { id: 'monitor' as NavTab, label: 'Home', icon: Activity },
            { id: 'elections' as NavTab, label: 'Elections', icon: SlidersHorizontal },
            { id: 'voters' as NavTab, label: 'Voters', icon: Fingerprint },
            { id: 'results' as NavTab, label: 'Results', icon: Lock },
            { id: 'workbench' as NavTab, label: 'ESP32', icon: Cpu },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors cursor-pointer ${
                  active ? 'text-sky-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate max-w-full px-0.5">{item.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className={`flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors cursor-pointer ${
              activeTab === 'docs' || activeTab === 'security'
                ? 'text-sky-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Menu className="w-4 h-4 shrink-0" />
            <span>More</span>
          </button>
        </div>
      </nav>

      {/* Non-intrusive Toast Notification (Raised above mobile bottom nav) */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-20 lg:bottom-4 left-3 right-3 sm:left-auto sm:right-4 z-50 sm:max-w-md rounded-lg border px-4 py-3 text-xs font-medium shadow-xl flex items-start gap-2.5 ${
            toast.tone === 'success'
              ? 'bg-[#0F241D] border-emerald-500/40 text-emerald-200'
              : toast.tone === 'error'
                ? 'bg-[#2A1216] border-red-500/40 text-red-200'
                : 'bg-[#131C2E] border-sky-500/40 text-slate-100'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="leading-relaxed flex-1">{toast.msg}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-slate-400 hover:text-slate-200 ml-1 cursor-pointer"
            aria-label="Dismiss message"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}
