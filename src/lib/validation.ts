import type {
  Candidate,
  Election,
  EvmBooth,
  PreElectionValidationReport,
  ValidationCheckResult,
} from '../types/evm';

export const ESP32_ARDUINO_JSON_LIMIT_BYTES = 16384; // 16 KB safe StaticJsonDocument / DynamicJsonDocument budget

export const PARTY_EMBLEM_PRESETS = [
  {
    label: 'Civic Alliance Crest',
    url: '/src/assets/images/emblem_civic_alliance_1795194640774.jpg',
    color: '#38BDF8',
  },
  {
    label: 'Green Future Oak & Compass',
    url: '/src/assets/images/emblem_green_future_1795194625335.jpg',
    color: '#10B981',
  },
  {
    label: 'Meridian Reform Scales',
    url: '/src/assets/images/emblem_meridian_reform_1795195036863.jpg',
    color: '#F59E0B',
  },
  {
    label: 'Unity Progress Shield',
    url: '/src/assets/images/emblem_unity_progress_1795194643545.jpg',
    color: '#EF4444',
  },
] as const;

export const ESP32_HARDWARE_IMAGE_URL =
  '/src/assets/images/esp32_evm_hardware_1795194627954.jpg';

/**
 * Resolves candidate emblem URLs so previously stored Firestore candidate records
 * referencing earlier generated image filenames always render the live asset.
 */
export function resolveEmblemUrl(rawUrl?: string | null, fallbackIndex = 0): string {
  const url = (rawUrl || '').trim();
  if (!url) {
    return PARTY_EMBLEM_PRESETS[Math.abs(fallbackIndex) % PARTY_EMBLEM_PRESETS.length].url;
  }
  if (url.includes('emblem_civic_alliance')) return PARTY_EMBLEM_PRESETS[0].url;
  if (url.includes('emblem_green_future')) return PARTY_EMBLEM_PRESETS[1].url;
  if (url.includes('emblem_meridian_reform')) return PARTY_EMBLEM_PRESETS[2].url;
  if (url.includes('emblem_unity_progress')) return PARTY_EMBLEM_PRESETS[3].url;
  if (url.includes('esp32_evm_hardware')) return ESP32_HARDWARE_IMAGE_URL;
  return url;
}

export async function computeSha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function buildCompactEsp32BallotPayload(
  election: Election,
  candidates: Candidate[]
): string {
  const compact = {
    eid: election.id,
    ver: election.ballotVersion,
    st: election.startTime,
    et: election.endTime,
    c: [...candidates]
      .sort((a, b) => a.ballotNumber - b.ballotNumber)
      .map((cand) => ({
        id: cand.id,
        n: cand.ballotNumber,
        nm: cand.name,
        p: cand.party,
        ct: cand.constituency,
      })),
  };
  return JSON.stringify(compact);
}

/**
 * Runs the comprehensive Pre-Election Configuration Validation Workflow
 * required before an election can be opened or pushed live to ESP32 devices.
 */
export async function runPreElectionValidation(
  election: Election,
  candidates: Candidate[],
  booths: EvmBooth[]
): Promise<PreElectionValidationReport> {
  const checks: ValidationCheckResult[] = [];
  const electionBooths = booths.filter((b) => b.electionId === election.id);

  // 1. Schedule Logic: Valid ISO timestamps & End > Start
  const startMs = Date.parse(election.startTime);
  const endMs = Date.parse(election.endTime);
  const durationMinutes = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.round((endMs - startMs) / 60000)
    : -1;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    checks.push({
      id: 'schedule-valid-dates',
      category: 'schedule',
      title: 'Polling schedule timestamps',
      status: 'fail',
      detail: 'Start time and end time must both be valid ISO-8601 date-time values.',
      blocking: true,
    });
  } else if (endMs <= startMs) {
    checks.push({
      id: 'schedule-order',
      category: 'schedule',
      title: 'Chronological polling window',
      status: 'fail',
      detail: 'Poll closing time must occur strictly after the poll opening time.',
      blocking: true,
    });
  } else if (durationMinutes < 30) {
    checks.push({
      id: 'schedule-duration',
      category: 'schedule',
      title: 'Minimum polling window duration',
      status: 'fail',
      detail: `Configured window is only ${durationMinutes} min. Minimum required polling duration is 30 minutes.`,
      blocking: true,
    });
  } else {
    const hours = (durationMinutes / 60).toFixed(1);
    checks.push({
      id: 'schedule-order',
      category: 'schedule',
      title: 'Logical polling window verified',
      status: 'pass',
      detail: `Window spans ${hours} hours (${new Date(startMs).toLocaleString()} to ${new Date(endMs).toLocaleString()}).`,
      blocking: true,
    });
  }

  // Non-blocking warning if draft election starts in the past
  if (election.status === 'draft' && Number.isFinite(startMs) && startMs < Date.now() - 60000) {
    checks.push({
      id: 'schedule-past-start',
      category: 'schedule',
      title: 'Draft start time check',
      status: 'warn',
      detail: 'Start timestamp is in the past; booths will immediately accept ballots once opened.',
      blocking: false,
    });
  }

  // 2. Duplicate Candidate Checks (Name per constituency, Ballot Number per constituency, Party per constituency)
  const seenNames = new Set<string>();
  const duplicateNames: string[] = [];
  const seenBallotNums = new Set<string>();
  const duplicateBallotNums: string[] = [];
  const seenPartySeat = new Set<string>();
  const duplicateParties: string[] = [];

  for (const c of candidates) {
    const nameKey = `${c.constituency.trim().toLowerCase()}::${c.name.trim().toLowerCase()}`;
    if (seenNames.has(nameKey)) {
      duplicateNames.push(`${c.name} (${c.constituency})`);
    }
    seenNames.add(nameKey);

    const numKey = `${c.constituency.trim().toLowerCase()}::${c.ballotNumber}`;
    if (seenBallotNums.has(numKey)) {
      duplicateBallotNums.push(`#${c.ballotNumber} in ${c.constituency}`);
    }
    seenBallotNums.add(numKey);

    const partyKey = `${c.constituency.trim().toLowerCase()}::${c.party.trim().toLowerCase()}`;
    if (seenPartySeat.has(partyKey) && c.party.trim().toLowerCase() !== 'independent') {
      duplicateParties.push(`${c.party} in ${c.constituency}`);
    }
    seenPartySeat.add(partyKey);
  }

  checks.push({
    id: 'candidate-duplicate-names',
    category: 'candidates',
    title: 'Duplicate candidate entries',
    status: duplicateNames.length > 0 ? 'fail' : 'pass',
    detail:
      duplicateNames.length > 0
        ? `Duplicate candidate name(s) detected: ${duplicateNames.join(', ')}.`
        : 'All candidate names are unique within their respective constituencies.',
    blocking: true,
  });

  checks.push({
    id: 'candidate-duplicate-ballot-numbers',
    category: 'candidates',
    title: 'Unique ESP32 keypad ballot numbers',
    status: duplicateBallotNums.length > 0 ? 'fail' : 'pass',
    detail:
      duplicateBallotNums.length > 0
        ? `Conflicting keypad ballot positions: ${duplicateBallotNums.join(', ')}. Each physical ESP32 button requires a unique index.`
        : 'Every candidate maps to a distinct ESP32 tactile keypad button index.',
    blocking: true,
  });

  if (duplicateParties.length > 0) {
    checks.push({
      id: 'candidate-duplicate-party',
      category: 'candidates',
      title: 'Multiple nominees from same party',
      status: 'warn',
      detail: `Multiple candidates registered under the same party in one constituency: ${duplicateParties.join(', ')}.`,
      blocking: false,
    });
  }

  // 3. Candidate Required Data & Verified Logos/Emblems
  const missingDataList: string[] = [];
  const invalidLogoList: string[] = [];

  for (const c of candidates) {
    if (
      !c.name ||
      c.name.trim().length < 2 ||
      !c.party ||
      c.party.trim().length < 2 ||
      !c.constituency ||
      !election.constituencies.includes(c.constituency) ||
      !Number.isInteger(c.ballotNumber) ||
      c.ballotNumber < 1
    ) {
      missingDataList.push(c.name || c.id);
    }

    const url = (c.symbolUrl || '').trim();
    const validLogo =
      url.startsWith('/src/assets/') ||
      url.startsWith('/') ||
      url.startsWith('https://') ||
      url.startsWith('data:image/');
    if (!url || !validLogo) {
      invalidLogoList.push(c.name || c.id);
    }
  }

  checks.push({
    id: 'candidate-completeness',
    category: 'candidates',
    title: 'Candidate metadata completeness',
    status: missingDataList.length > 0 ? 'fail' : 'pass',
    detail:
      missingDataList.length > 0
        ? `Incomplete or mismatched constituency metadata for: ${missingDataList.join(', ')}.`
        : `All ${candidates.length} candidate entries have valid names, parties, constituencies, and keypad indices.`,
    blocking: true,
  });

  checks.push({
    id: 'candidate-logos',
    category: 'candidates',
    title: 'Candidate party emblems / logos verified',
    status: invalidLogoList.length > 0 ? 'fail' : 'pass',
    detail:
      invalidLogoList.length > 0
        ? `Missing or malformed emblem URL for: ${invalidLogoList.join(', ')}.`
        : 'All candidates have verified party emblem assets attached.',
    blocking: true,
  });

  // 4. Ballot Formation & Constituency Quorum (>= 2 candidates per constituency)
  const underpopulated: string[] = [];
  for (const constituency of election.constituencies) {
    const count = candidates.filter((c) => c.constituency === constituency).length;
    if (count < 2) {
      underpopulated.push(`${constituency} (${count})`);
    }
  }

  checks.push({
    id: 'ballot-quorum',
    category: 'ballot',
    title: 'Constituency ballot quorum (min 2 candidates)',
    status: underpopulated.length > 0 || candidates.length < 2 ? 'fail' : 'pass',
    detail:
      underpopulated.length > 0
        ? `Constituency requires at least 2 candidates to form a contested ballot: ${underpopulated.join(', ')}.`
        : `All ${election.constituencies.length} constituency ballot(s) meet contested quorum.`,
    blocking: true,
  });

  // 5. ESP32 JSON Payload Size & SHA-256 Manifest Hash
  const compactJson = buildCompactEsp32BallotPayload(election, candidates);
  const ballotPayloadBytes = new TextEncoder().encode(compactJson).length;
  const computedBallotHash = await computeSha256Hex(compactJson);

  checks.push({
    id: 'ballot-esp32-memory',
    category: 'ballot',
    title: 'ESP32 ArduinoJson memory & manifest hash',
    status: ballotPayloadBytes > ESP32_ARDUINO_JSON_LIMIT_BYTES ? 'fail' : 'pass',
    detail:
      ballotPayloadBytes > ESP32_ARDUINO_JSON_LIMIT_BYTES
        ? `Serialized ballot (${ballotPayloadBytes} B) exceeds ESP32 ${ESP32_ARDUINO_JSON_LIMIT_BYTES} B RAM ceiling.`
        : `Compact ballot manifest is ${ballotPayloadBytes} bytes (${((ballotPayloadBytes / ESP32_ARDUINO_JSON_LIMIT_BYTES) * 100).toFixed(1)}% of 16 KB ESP32 JSON budget). SHA-256: ${computedBallotHash.slice(0, 12)}…`,
    blocking: true,
  });

  // 6. Provisioned ESP32 Booth Readiness
  const onlineOrDegradedBooths = electionBooths.filter(
    (b) => b.status === 'online' || b.status === 'degraded'
  );
  const tamperedBooths = electionBooths.filter((b) => b.status === 'tampered');

  if (electionBooths.length === 0) {
    checks.push({
      id: 'hardware-booths-assigned',
      category: 'hardware',
      title: 'Assigned ESP32 EVM booths',
      status: 'fail',
      detail: 'No ESP32 polling booths are provisioned for this election yet.',
      blocking: true,
    });
  } else if (tamperedBooths.length > 0) {
    checks.push({
      id: 'hardware-booths-tampered',
      category: 'hardware',
      title: 'Hardware tamper lock verification',
      status: 'fail',
      detail: `${tamperedBooths.length} assigned booth(s) currently report active tamper alerts (${tamperedBooths.map((b) => b.boothCode).join(', ')}). Clear or quarantine before push.`,
      blocking: true,
    });
  } else if (onlineOrDegradedBooths.length === 0) {
    checks.push({
      id: 'hardware-booths-online',
      category: 'hardware',
      title: 'Online ESP32 booth connectivity',
      status: 'warn',
      detail: `${electionBooths.length} booth(s) assigned, but none are currently online. Ballots will queue until booths reconnect.`,
      blocking: false,
    });
  } else {
    checks.push({
      id: 'hardware-booths-ready',
      category: 'hardware',
      title: 'ESP32 hardware fleet readiness',
      status: 'pass',
      detail: `${onlineOrDegradedBooths.length} of ${electionBooths.length} provisioned ESP32 booths online with nominal tamper seals.`,
      blocking: true,
    });
  }

  const blockingFailures = checks.filter((c) => c.blocking && c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const passedChecks = checks.filter((c) => c.status === 'pass').length;

  return {
    readyToDeploy: blockingFailures === 0,
    blockingFailures,
    warnings,
    passedChecks,
    ballotPayloadBytes,
    computedBallotHash,
    checks,
  };
}
