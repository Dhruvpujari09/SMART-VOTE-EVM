import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  HardDrive,
  KeyRound,
  Radio,
  Server,
  ShieldAlert,
  Terminal,
  Wifi,
} from 'lucide-react';
import { ESP32_ENDPOINT_SPECS } from '../lib/esp32FirmwareSpecs';
import { ESP32_HARDWARE_IMAGE_URL } from '../lib/validation';
import type { Election, EvmBooth } from '../types/evm';

interface Props {
  election: Election | null;
  booths: EvmBooth[];
  gatewayConnected: boolean;
  onOpenHardwareTab: (boothId?: string) => void;
  onNavigate: (tab: string) => void;
}

const HARDWARE_PINS = [
  {
    component: 'R307 / AS608 Fingerprint Sensor',
    pins: 'TX → GPIO 16 (RX2), RX → GPIO 17 (TX2), 3.3V, GND',
    role: 'Stores templates locally in sensor flash; only opaque IDs (FP-xxx) are transmitted.',
  },
  {
    component: '16×2 I2C LCD (PCF8574)',
    pins: 'SDA → GPIO 21, SCL → GPIO 22, VCC, GND',
    role: 'Displays live server-returned lcdLine1 & lcdLine2 prompts and offline queue count.',
  },
  {
    component: 'Candidate Push Buttons',
    pins: 'GPIO 12, 13, 14, 27, 26, 25 (INPUT_PULLUP)',
    role: 'Maps physical buttons 1..N to each candidate num (ballotNumber) from /api/esp32/ballot.',
  },
  {
    component: 'Buzzer & Status LEDs',
    pins: 'Buzzer → GPIO 4, Green LED → GPIO 2, Red LED → GPIO 15',
    role: 'Immediate voter audio/visual feedback on verification, vote receipt, or duplicate rejection.',
  },
  {
    component: 'Chassis Tamper Reed Switch',
    pins: 'GPIO 33 (INPUT_PULLUP, RISING interrupt)',
    role: 'Calls POST /api/esp32/tamper and locks keypad if hardware enclosure is opened.',
  },
  {
    component: 'Battery Sense Divider (Optional)',
    pins: 'GPIO 34 (ADC1_CH6)',
    role: 'Reports batteryPct (0–100) in every 15-second heartbeat payload.',
  },
];

const VERIFICATION_STEPS = [
  {
    step: '01',
    title: 'Confirm Gateway WebSocket & Booth Sync',
    action: 'Open ESP32 Hardware → Interactive Device Console',
    detail:
      'Verify the top gateway indicator reads Connected (WSS) and pick your provisioned booth from the Target ESP32 Booth selector. All Firestore booths, ballots, and enrolled voters are automatically mirrored to the Express gateway.',
    expected: 'GET /api/health returns status: "ok" and registeredBooths > 0.',
  },
  {
    step: '02',
    title: 'Test Authenticated Heartbeat & Ballot Download',
    action: 'Click Send Heartbeat, then Pull Ballot Manifest',
    detail:
      'The workbench sends authenticated requests with X-Device-ID and X-Device-API-Key to POST /api/esp32/heartbeat and GET /api/esp32/ballot. Inspect the Live HTTP Inspector to confirm HTTP 200 and verify payloadBytes stays well under the 16 KB ArduinoJson budget.',
    expected: 'ack: true, latestBallotVersion matches election, and compact candidates array returned.',
  },
  {
    step: '03',
    title: 'Verify Real-Time Anti-Duplicate Voting Flow',
    action: 'Select an enrolled voter → Verify Voter → Cast Vote',
    detail:
      'Run POST /api/esp32/verify-voter first to confirm eligible: true, then POST /api/esp32/cast-vote. Immediately click Verify Voter or Cast Vote a second time for the same voter to verify cross-booth double-voting is rejected.',
    expected: 'First vote returns HTTP 200 (COMMITTED + receiptHash); second attempt returns HTTP 409 (ALREADY_VOTED_GLOBALLY).',
  },
  {
    step: '04',
    title: 'Verify Offline LittleFS Queue & Reconnect Sync',
    action: 'Toggle Simulate Wi-Fi Drop → Queue Offline Vote → Reconnect & Flush Queue',
    detail:
      'While offline, ballots are buffered locally with monotonic NVS sequence numbers and local template dedupe. Reconnecting invokes POST /api/esp32/offline-sync and reconciles committed ballots while rejecting any cross-booth double-vote conflicts.',
    expected: 'reconciled: true with per-vote COMMITTED / CONFLICT_REJECTED_ALREADY_VOTED summary.',
  },
  {
    step: '05',
    title: 'Test Hardware Tamper Lockout & Clearance',
    action: 'Click Trigger Tamper Alert, then clear from Overview',
    detail:
      'Fires POST /api/esp32/tamper with enclosure_open. Confirm the booth immediately switches to Tamper Lockout in Overview and logs a critical security event in Security & Audit.',
    expected: 'HTTP 200 action: "LOCK_BOOTH_IMMEDIATELY" and live dashboard alert broadcast over /ws.',
  },
  {
    step: '06',
    title: 'Flash Physical ESP32 & Watch Live Telemetry',
    action: 'Switch to Arduino / ESP-IDF Firmware sub-tab in ESP32 Hardware',
    detail:
      'Copy the full LittleFS + WebSocketsClient sketch, paste your Wi-Fi credentials, deployed host URL, DEVICE_ID, and one-time sv_esp32_... API key, then flash. Watch incoming live heartbeats stream into the WebSocket Event Stream panel.',
    expected: 'Physical booth status turns Online · Synced with real Wi-Fi RSSI (dBm) and latency (ms).',
  },
];

export const Esp32SetupDocsView: React.FC<Props> = ({
  election,
  booths,
  gatewayConnected,
  onOpenHardwareTab,
  onNavigate,
}) => {
  const [selectedBoothId, setSelectedBoothId] = useState<string>(booths[0]?.id || '');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const electionBooths = useMemo(
    () => (election ? booths.filter((b) => b.electionId === election.id) : booths),
    [booths, election]
  );

  const activeBooth = useMemo(
    () => electionBooths.find((b) => b.id === selectedBoothId) || electionBooths[0] || null,
    [electionBooths, selectedBoothId]
  );

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-smart-vote-host';
  const isHttps = origin.startsWith('https://');
  const hostOnly = origin.replace(/^https?:\/\//, '');
  const wsScheme = isHttps ? 'wss' : 'ws';
  const deviceId = activeBooth?.id || 'booth_xxxxxxxxxxxx';
  const electionId = election?.id || 'el_xxxxxxxxxxxx';
  const apiKeyPlaceholder = activeBooth
    ? `${activeBooth.apiKeyPrefix}••••••••••••••••`
    : 'sv_esp32_your_one_time_key';

  const copyBlock = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const firmwareConfigSnippet = `// Smart Vote ESP32 Firmware Configuration (Arduino / PlatformIO)
const char* WIFI_SSID       = "YOUR_POLLING_STATION_WIFI";
const char* WIFI_PASS       = "YOUR_WIFI_PASSWORD";

// Production HTTPS host or local LAN dev server (e.g. http://192.168.1.50:3000)
const char* API_BASE_URL    = "${origin}";
const char* WS_HOST         = "${hostOnly}";
const uint16_t WS_PORT      = ${isHttps ? 443 : 3000};
const char* WS_PATH         = "/ws?role=esp32&boothId=${deviceId}";

// Provisioned Booth Credentials (Generated in Smart Vote -> Elections -> Provision ESP32 Booth)
const char* ELECTION_ID     = "${electionId}";
const char* DEVICE_ID       = "${deviceId}";
const char* DEVICE_API_KEY  = "${apiKeyPlaceholder}"; // Replace with full one-time key`;

  const authHeaderSnippet = `// Attach these 3 headers to EVERY HTTPClient request to /api/esp32/*
http.begin(secureClient, String(API_BASE_URL) + "/api/esp32/heartbeat");
http.addHeader("Content-Type", "application/json");
http.addHeader("X-Device-ID", DEVICE_ID);
http.addHeader("X-Device-API-Key", DEVICE_API_KEY);
int httpCode = http.POST(jsonPayload);`;

  const curlSmokeTest = `curl -X POST "${origin}/api/esp32/heartbeat" \\
  -H "Content-Type: application/json" \\
  -H "X-Device-ID: ${deviceId}" \\
  -H "X-Device-API-Key: <PASTE_FULL_sv_esp32_KEY>" \\
  -d '{
    "rssi": -54,
    "latencyMs": 38,
    "batteryPct": 95,
    "firmwareVersion": "2.4.1-esp32",
    "ballotVersion": ${election?.ballotVersion ?? 1},
    "tamperState": "nominal",
    "pendingOfflineVotes": 0,
    "offlineQueueBytes": 0,
    "lcdMessage": "READY - PLACE FINGER"
  }'`;

  const wsIncomingCommandExample = `{
  "event": "esp32:command",
  "timestamp": "2026-11-20T14:10:00.000Z",
  "payload": {
    "commandId": "cmd_1763647800_a1b2c3",
    "type": "ENROLL_FINGERPRINT",
    "voterDocId": "voter_xxxxxxxx",
    "voterName": "Clara Morales"
  }
}`;

  const tamperSpec = {
    method: 'POST',
    path: '/api/esp32/tamper',
    purpose: 'Immediate chassis tamper lockout alert triggered by GPIO 33 reed switch',
    requestJson: `{
  "tamperState": "enclosure_open",
  "details": "Hardware reed switch triggered on EVM chassis"
}`,
    responseJson: `{
  "acknowledged": true,
  "action": "LOCK_BOOTH_IMMEDIATELY",
  "tamperState": "enclosure_open"
}`,
  };

  return (
    <div className="space-y-6">
      {/* Top Documentation Header + Live Booth Context Auto-Fill */}
      <div className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/25 text-sky-400 shrink-0">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">
                ESP32 Firmware Connection &amp; API Integration Guide
              </h2>
              <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
                Step-by-step hardware configuration, HTTP authentication headers, REST &amp; WebSocket API contracts, LittleFS offline queue protocol, and live verification inside the{' '}
                <strong className="text-slate-200">ESP32 Hardware</strong> console.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('elections')}
              className="px-3.5 py-2 rounded-lg border border-slate-700 bg-[#0B1120] hover:bg-slate-800 text-slate-200 text-xs font-medium transition-colors cursor-pointer"
            >
              Provision Booth
            </button>
            <button
              type="button"
              onClick={() => onOpenHardwareTab(activeBooth?.id)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              Open ESP32 Hardware Tab
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Dynamic Booth Selector & Section Anchor Navigation */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 pt-4 border-t border-slate-800 items-center">
          <div className="lg:col-span-5 flex flex-wrap items-center gap-2.5">
            <label htmlFor="docs-booth-select" className="text-xs text-slate-400 shrink-0">
              Auto-fill snippets for booth:
            </label>
            <select
              id="docs-booth-select"
              value={activeBooth?.id || ''}
              onChange={(e) => setSelectedBoothId(e.target.value)}
              className="flex-1 min-w-[180px] bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-400"
            >
              {electionBooths.length === 0 ? (
                <option value="">No booth provisioned (using placeholders)</option>
              ) : (
                electionBooths.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.boothCode} — {b.constituency}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="lg:col-span-7 flex flex-wrap items-center lg:justify-end gap-2 text-xs">
            {[
              { href: '#doc-step-1', label: '1. Wiring & Provision' },
              { href: '#doc-step-2', label: '2. Auth Headers & Config' },
              { href: '#doc-step-3', label: '3. REST & WS API' },
              { href: '#doc-step-4', label: '4. Offline Queue' },
              { href: '#doc-step-5', label: '5. Live Verification' },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="px-2.5 py-1 rounded-md bg-[#0B1120] border border-slate-800 hover:border-sky-500/40 text-slate-300 hover:text-sky-300 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* STEP 1: Hardware Pinout & Booth Provisioning */}
      <section id="doc-step-1" className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5 scroll-mt-20">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider">Step 1 of 5</div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5">
              Hardware Wiring, Partition Scheme &amp; Booth Provisioning
            </h3>
          </div>
          <span className="font-mono text-xs text-slate-400">
            Board: ESP32 Dev Module · Partition: Default 4MB with spiffs
          </span>
        </div>

        {/* Visual Hardware Reference & Pinout Wiring Schematic Drawing */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7 bg-[#0B1120] border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span className="text-sky-400 uppercase tracking-wider">ESP32-WROOM-32 EVM Wiring Schematic</span>
              <span>UART2 · I2C · GPIO · TLS/WSS</span>
            </div>
            <svg
              viewBox="0 0 680 260"
              className="w-full h-auto block"
              role="img"
              aria-label="ESP32 EVM hardware wiring schematic connecting fingerprint sensor, I2C LCD, keypad, tamper switch, buzzer, and cloud gateway"
            >
              {/* Subtle Blueprint Grid */}
              <defs>
                <pattern id="evm-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1E293B" strokeWidth="0.6" />
                </pattern>
              </defs>
              <rect width="680" height="260" rx="8" fill="#0B1120" />
              <rect width="680" height="260" rx="8" fill="url(#evm-grid)" />

              {/* Left Peripherals */}
              {/* R307 / AS608 Fingerprint Sensor */}
              <rect x="18" y="22" width="168" height="62" rx="8" fill="#131C2E" stroke="#38BDF8" strokeWidth="1.5" />
              <text x="30" y="44" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">R307 / AS608 Sensor</text>
              <text x="30" y="61" fill="#38BDF8" fontSize="10" fontFamily="monospace">TX→GPIO16 · RX→GPIO17</text>
              <text x="30" y="75" fill="#94A3B8" fontSize="9.5" fontFamily="sans-serif">UART2 Biometric Flash</text>

              {/* 16x2 I2C LCD */}
              <rect x="18" y="99" width="168" height="62" rx="8" fill="#131C2E" stroke="#10B981" strokeWidth="1.5" />
              <text x="30" y="121" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">16×2 I2C LCD (0x27)</text>
              <text x="30" y="138" fill="#34D399" fontSize="10" fontFamily="monospace">SDA→GPIO21 · SCL→GPIO22</text>
              <text x="30" y="152" fill="#94A3B8" fontSize="9.5" fontFamily="sans-serif">Live Prompts + Queue</text>

              {/* Candidate Keypad */}
              <rect x="18" y="176" width="168" height="62" rx="8" fill="#131C2E" stroke="#F59E0B" strokeWidth="1.5" />
              <text x="30" y="198" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">Candidate Buttons</text>
              <text x="30" y="215" fill="#FBBF24" fontSize="10" fontFamily="monospace">GPIO 12,13,14,27,26,25</text>
              <text x="30" y="229" fill="#94A3B8" fontSize="9.5" fontFamily="sans-serif">INPUT_PULLUP Ballot Keys</text>

              {/* Center ESP32 Core */}
              <rect x="242" y="42" width="196" height="176" rx="12" fill="#17253D" stroke="#38BDF8" strokeWidth="2" />
              <rect x="256" y="56" width="168" height="28" rx="6" fill="#0B1120" stroke="#334155" strokeWidth="1" />
              <text x="340" y="74" textAnchor="middle" fill="#38BDF8" fontSize="12" fontWeight="700" fontFamily="monospace">ESP32-WROOM-32</text>
              <text x="340" y="106" textAnchor="middle" fill="#E2E8F0" fontSize="10.5" fontWeight="600" fontFamily="sans-serif">Smart Vote Firmware v2.4</text>
              <rect x="258" y="118" width="164" height="24" rx="5" fill="#0B1120" stroke="#1E3A5F" />
              <text x="340" y="134" textAnchor="middle" fill="#7DD3FC" fontSize="9.5" fontFamily="monospace">LittleFS Offline Queue</text>
              <rect x="258" y="148" width="164" height="24" rx="5" fill="#0B1120" stroke="#1E3A5F" />
              <text x="340" y="164" textAnchor="middle" fill="#34D399" fontSize="9.5" fontFamily="monospace">NVS Key &amp; Seq Storage</text>
              <rect x="258" y="178" width="164" height="24" rx="5" fill="#0B1120" stroke="#1E3A5F" />
              <text x="340" y="194" textAnchor="middle" fill="#FBBF24" fontSize="9.5" fontFamily="monospace">WiFiClientSecure TLS</text>

              {/* Right Peripherals & Gateway */}
              {/* Smart Vote Gateway */}
              <rect x="494" y="22" width="168" height="68" rx="8" fill="#131C2E" stroke="#38BDF8" strokeWidth="1.5" />
              <text x="506" y="44" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">Smart Vote Server</text>
              <text x="506" y="61" fill="#38BDF8" fontSize="10" fontFamily="monospace">REST /api/esp32/*</text>
              <text x="506" y="76" fill="#34D399" fontSize="10" fontFamily="monospace">WSS  /ws?role=esp32</text>

              {/* Tamper Reed Switch */}
              <rect x="494" y="104" width="168" height="58" rx="8" fill="#131C2E" stroke="#EF4444" strokeWidth="1.5" />
              <text x="506" y="125" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">Tamper Switch</text>
              <text x="506" y="142" fill="#F87171" fontSize="10" fontFamily="monospace">GPIO 33 (RISING IRQ)</text>
              <text x="506" y="155" fill="#94A3B8" fontSize="9.5" fontFamily="sans-serif">Instant Chassis Lock</text>

              {/* Buzzer + Status LEDs + Battery */}
              <rect x="494" y="176" width="168" height="62" rx="8" fill="#131C2E" stroke="#94A3B8" strokeWidth="1.5" />
              <text x="506" y="198" fill="#F1F5F9" fontSize="11.5" fontWeight="700" fontFamily="monospace">Buzzer, LEDs &amp; ADC</text>
              <text x="506" y="215" fill="#CBD5E1" fontSize="10" fontFamily="monospace">GPIO 4, 2, 15 · ADC 34</text>
              <text x="506" y="229" fill="#94A3B8" fontSize="9.5" fontFamily="sans-serif">Audio + Battery Sense</text>

              {/* Connecting Bus Lines */}
              <path d="M 186 53 L 214 53 L 214 82 L 242 82" fill="none" stroke="#38BDF8" strokeWidth="2" />
              <circle cx="242" cy="82" r="3.5" fill="#38BDF8" />

              <path d="M 186 130 L 242 130" fill="none" stroke="#10B981" strokeWidth="2" />
              <circle cx="242" cy="130" r="3.5" fill="#10B981" />

              <path d="M 186 207 L 214 207 L 214 178 L 242 178" fill="none" stroke="#F59E0B" strokeWidth="2" />
              <circle cx="242" cy="178" r="3.5" fill="#F59E0B" />

              <path d="M 438 82 L 466 82 L 466 56 L 494 56" fill="none" stroke="#38BDF8" strokeWidth="2" strokeDasharray="5 3" />
              <circle cx="438" cy="82" r="3.5" fill="#38BDF8" />
              <circle cx="494" cy="56" r="3.5" fill="#38BDF8" />

              <path d="M 438 133 L 494 133" fill="none" stroke="#EF4444" strokeWidth="2" />
              <circle cx="438" cy="133" r="3.5" fill="#EF4444" />

              <path d="M 438 178 L 466 178 L 466 207 L 494 207" fill="none" stroke="#94A3B8" strokeWidth="2" />
              <circle cx="438" cy="178" r="3.5" fill="#94A3B8" />
            </svg>
          </div>

          <div className="lg:col-span-5 relative rounded-xl overflow-hidden border border-slate-800 bg-[#0B1120] min-h-[210px] aspect-[16/9] lg:aspect-auto">
            <img
              src={ESP32_HARDWARE_IMAGE_URL}
              alt="ESP32 Fingerprint Electronic Voting Machine reference terminal"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover block"
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0B1120]/90 via-[#0B1120]/45 to-transparent px-4 py-3">
              <div className="text-xs font-semibold text-slate-100">Reference ESP32 EVM Unit</div>
              <div className="font-mono text-[11px] text-slate-300">
                Optical R307/AS608 · 16×2 LCD · Tactile Keypad
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-800 rounded-lg">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[#0F172A] border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-4 font-medium">Peripheral</th>
                <th className="py-2.5 px-4 font-medium">ESP32 GPIO Mapping</th>
                <th className="py-2.5 px-4 font-medium">Smart Vote Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {HARDWARE_PINS.map((row) => (
                <tr key={row.component} className="bg-[#0B1120]/60">
                  <td className="py-3 px-4 font-medium text-slate-100 whitespace-nowrap">{row.component}</td>
                  <td className="py-3 px-4 font-mono text-sky-300">{row.pins}</td>
                  <td className="py-3 px-4 text-slate-400">{row.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="font-semibold text-slate-100">1A. Install Arduino / PlatformIO Libraries</div>
            <p className="text-slate-400 leading-relaxed">
              Install <span className="font-mono text-slate-200">ArduinoJson (v7)</span>,{' '}
              <span className="font-mono text-slate-200">Adafruit Fingerprint</span>,{' '}
              <span className="font-mono text-slate-200">LiquidCrystal_I2C</span>, and{' '}
              <span className="font-mono text-slate-200">WebSocketsClient</span> alongside built-in{' '}
              <span className="font-mono text-slate-200">WiFiClientSecure</span>,{' '}
              <span className="font-mono text-slate-200">LittleFS</span>, and{' '}
              <span className="font-mono text-slate-200">Preferences</span>.
            </p>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="font-semibold text-slate-100">1B. Provision Credentials in Smart Vote</div>
            <p className="text-slate-400 leading-relaxed">
              In <strong className="text-slate-200">Elections → Provision ESP32 Booth</strong>, register the station to receive its{' '}
              <span className="font-mono text-sky-300">DEVICE_ID</span> and one-time{' '}
              <span className="font-mono text-sky-300">sv_esp32_…</span> API key. Only the SHA-256 hash is persisted in Firestore.
            </p>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="font-semibold text-slate-100">1C. Network Reachability Note</div>
            <p className="text-slate-400 leading-relaxed">
              Physical ESP32 boards cannot pass browser Google login cookies on private preview links. Deploy Smart Vote to a public HTTPS host (Cloud Run / VPS) or run locally on your LAN (<span className="font-mono text-slate-200">http://&lt;LAN-IP&gt;:3000</span>).
            </p>
          </div>
        </div>
      </section>

      {/* STEP 2: Firmware Constants & Required HTTP Authentication Headers */}
      <section id="doc-step-2" className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5 scroll-mt-20">
        <div>
          <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider">Step 2 of 5</div>
          <h3 className="text-base font-semibold text-slate-100 mt-0.5">
            Firmware Connection Constants &amp; Required HTTP Auth Headers
          </h3>
        </div>

        {/* Auth Headers Specification Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
              <KeyRound className="w-3.5 h-3.5" />
              X-Device-ID
            </div>
            <div className="text-xs text-slate-300">
              Exact Firestore booth document ID (e.g. <span className="font-mono text-slate-100">{deviceId}</span>). Used to look up booth constituency, election scope, and stored key hash.
            </div>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
              <KeyRound className="w-3.5 h-3.5" />
              X-Device-API-Key
            </div>
            <div className="text-xs text-slate-300">
              One-time booth secret (<span className="font-mono text-slate-100">sv_esp32_…</span>) stored in ESP32 NVS. Server computes SHA-256 and verifies against <span className="font-mono text-slate-200">apiKeyHash</span>.
            </div>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
              <Server className="w-3.5 h-3.5" />
              Content-Type &amp; Auth Errors
            </div>
            <div className="text-xs text-slate-300">
              Send <span className="font-mono text-slate-100">application/json</span> on all POST routes. Failure codes:{' '}
              <span className="font-mono text-amber-300">401 MISSING_DEVICE_CREDENTIALS</span>,{' '}
              <span className="font-mono text-red-300">403 UNKNOWN_DEVICE</span>,{' '}
              <span className="font-mono text-red-300">403 INVALID_API_KEY</span>.
            </div>
          </div>
        </div>

        {/* Copyable C++ Config & Header Usage */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-[#0B1120] border border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-200">Firmware Connection Constants (config.h)</span>
              <button
                type="button"
                onClick={() => copyBlock('fw-config', firmwareConfigSnippet)}
                className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
              >
                {copiedId === 'fw-config' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === 'fw-config' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="p-4 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed">
              {firmwareConfigSnippet}
            </pre>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-200">Attaching Auth Headers in HTTPClient</span>
              <button
                type="button"
                onClick={() => copyBlock('fw-headers', authHeaderSnippet)}
                className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
              >
                {copiedId === 'fw-headers' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === 'fw-headers' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="p-4 text-[11px] font-mono text-sky-200 overflow-x-auto leading-relaxed flex-1">
              {authHeaderSnippet}
            </pre>
            <div className="px-4 py-3 border-t border-slate-800 bg-[#0F172A]/70 text-[11px] text-slate-400">
              Tip: Pin your host TLS root CA with <span className="font-mono text-slate-200">secureClient.setCACert(ROOT_CA)</span> in production so ESP32 verifies TLS certificates before transmitting API keys.
            </div>
          </div>
        </div>
      </section>

      {/* STEP 3: API Endpoint Structure & WebSocket Channel */}
      <section id="doc-step-3" className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5 scroll-mt-20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider">Step 3 of 5</div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5">
              ESP32 REST API Endpoint Structure &amp; Real-Time WebSocket Channel
            </h3>
          </div>
          <span className="font-mono text-xs text-slate-400">
            Base URL: <span className="text-sky-300">{origin}</span>
          </span>
        </div>

        {/* WebSocket Real-Time Command Channel Card */}
        <div className="bg-[#0B1120] border border-sky-500/25 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
              <Radio className={`w-4 h-4 ${gatewayConnected ? 'text-emerald-400' : 'text-amber-400'}`} />
              Real-Time WebSocket Command Stream
            </div>
            <code className="text-[11px] font-mono text-sky-300 break-all">
              {wsScheme}://{hostOnly}/ws?role=esp32&amp;boothId={deviceId}
            </code>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Connect on boot so dashboard actions (<span className="font-mono text-slate-200">ENROLL_FINGERPRINT</span>,{' '}
            <span className="font-mono text-slate-200">SYNC_BALLOT</span>,{' '}
            <span className="font-mono text-slate-200">LOCK_BOOTH</span>) arrive instantaneously. If the WebSocket is temporarily disconnected, the gateway automatically queues the command and returns it in the next{' '}
            <span className="font-mono text-slate-200">POST /api/esp32/heartbeat</span> response.
          </p>
          <pre className="p-3 rounded bg-[#131C2E] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto">
            {wsIncomingCommandExample}
          </pre>
        </div>

        {/* All 7 ESP32 REST Endpoints */}
        <div className="space-y-3">
          {[...ESP32_ENDPOINT_SPECS, tamperSpec].map((ep) => (
            <div key={ep.path} className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={`font-mono text-[11px] font-semibold px-2 py-0.5 rounded ${
                      ep.method === 'GET'
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                    }`}
                  >
                    {ep.method}
                  </span>
                  <code className="font-mono text-xs text-slate-100">{ep.path}</code>
                </div>
                <span className="text-xs text-slate-400">{ep.purpose}</span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">
                    Request Payload
                  </div>
                  <pre className="p-3 rounded bg-[#131C2E] border border-slate-800 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed">
                    {ep.requestJson}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">
                    JSON Response
                  </div>
                  <pre className="p-3 rounded bg-[#131C2E] border border-slate-800 text-[11px] font-mono text-emerald-300/90 overflow-x-auto leading-relaxed">
                    {ep.responseJson}
                  </pre>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Copyable cURL Smoke Test */}
        <div className="bg-[#0B1120] border border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-200 flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-sky-400" />
              Pre-Flash Terminal Smoke Test (cURL)
            </span>
            <button
              type="button"
              onClick={() => copyBlock('curl-test', curlSmokeTest)}
              className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
            >
              {copiedId === 'curl-test' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedId === 'curl-test' ? 'Copied' : 'Copy cURL'}
            </button>
          </div>
          <pre className="p-4 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed">
            {curlSmokeTest}
          </pre>
        </div>
      </section>

      {/* STEP 4: Offline Voting Mode & Privacy Guarantees */}
      <section id="doc-step-4" className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-4 scroll-mt-20">
        <div>
          <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider">Step 4 of 5</div>
          <h3 className="text-base font-semibold text-slate-100 mt-0.5">
            Offline Voting Mode (LittleFS Flash Queue) &amp; Privacy Invariants
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-slate-100 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-amber-400" />
              LittleFS Persistent Files on ESP32 Flash
            </div>
            <ul className="space-y-1.5 text-slate-400 leading-relaxed">
              <li>
                <span className="font-mono text-slate-200">/ballot.json</span> — Cached constituency ballot manifest downloaded from <span className="font-mono">GET /api/esp32/ballot</span>.
              </li>
              <li>
                <span className="font-mono text-slate-200">/local_voted_templates.txt</span> — Local anti-duplicate template cache checked offline before unlocking the keypad.
              </li>
              <li>
                <span className="font-mono text-slate-200">/offline_queue.ndjson</span> — Append-only NDJSON vote queue paired with an NVS monotonic sequence counter (<span className="font-mono">Preferences</span>) to survive power cuts.
              </li>
              <li>
                On Wi-Fi reconnect, flush lines in batch to <span className="font-mono text-sky-300">POST /api/esp32/offline-sync</span> and remove acknowledged entries.
              </li>
            </ul>
          </div>

          <div className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-2">
            <div className="font-semibold text-slate-100 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-emerald-400" />
              Mandatory Security &amp; Privacy Rules
            </div>
            <ul className="space-y-1.5 text-slate-400 leading-relaxed">
              <li>
                <strong className="text-slate-200">Zero Raw Biometrics:</strong> Sending <span className="font-mono">rawImage</span>, <span className="font-mono">fingerprintImage</span>, <span className="font-mono">minutiae</span>, or <span className="font-mono">biometricBlob</span> to <span className="font-mono">/enroll-complete</span> is rejected with <span className="font-mono text-red-300">400 RAW_BIOMETRICS_PROHIBITED</span>.
              </li>
              <li>
                <strong className="text-slate-200">Strict Ballot Anonymity:</strong> Clear <span className="font-mono">voterDocId</span> from ESP32 RAM immediately after vote acknowledgment; the server decouples voter status from anonymized ballot records.
              </li>
              <li>
                <strong className="text-slate-200">Deterministic Conflict Resolution:</strong> If a voter cast a ballot online at another booth while this ESP32 was offline, <span className="font-mono">/offline-sync</span> returns <span className="font-mono text-amber-300">CONFLICT_REJECTED_ALREADY_VOTED</span> and leaves the tally untouched.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* STEP 5: Verifying Live Connection in the 'ESP32 Hardware' Tab */}
      <section id="doc-step-5" className="bg-[#131C2E] border border-slate-800 rounded-xl p-6 space-y-5 scroll-mt-20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider">Step 5 of 5</div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5">
              How to Use the &ldquo;ESP32 Hardware&rdquo; Tab to Verify the Live Connection
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onOpenHardwareTab(activeBooth?.id)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors cursor-pointer"
          >
            <Wifi className="w-3.5 h-3.5" />
            Launch ESP32 Hardware Console
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VERIFICATION_STEPS.map((item) => (
            <div
              key={item.step}
              className="bg-[#0B1120] border border-slate-800 rounded-lg p-4 space-y-2.5 flex flex-col justify-between"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold text-sky-400">CHECK {item.step}</span>
                  <span className="text-[11px] font-mono text-slate-500">{item.action}</span>
                </div>
                <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                <p className="text-xs text-slate-400 leading-relaxed">{item.detail}</p>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-start gap-2 text-[11px] text-emerald-300/90">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" />
                <span>{item.expected}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
