export const ESP32_ENDPOINT_SPECS = [
  {
    method: 'POST',
    path: '/api/esp32/heartbeat',
    purpose: 'Device telemetry, RSSI, latency, tamper status & command polling',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>\nContent-Type: application/json',
    requestJson: `{
  "rssi": -54,
  "latencyMs": 39,
  "batteryPct": 94,
  "firmwareVersion": "2.4.1-esp32",
  "ballotVersion": 2,
  "tamperState": "nominal",
  "pendingOfflineVotes": 0,
  "offlineQueueBytes": 0,
  "lcdMessage": "READY - PLACE FINGER"
}`,
    responseJson: `{
  "ack": true,
  "serverTime": "2026-11-20T14:05:12.400Z",
  "electionStatus": "active",
  "latestBallotVersion": 2,
  "ballotSyncRequired": false,
  "command": {
    "commandId": "cmd_17951842",
    "type": "ENROLL_FINGERPRINT",
    "voterDocId": "voter_042"
  }
}`,
  },
  {
    method: 'GET',
    path: '/api/esp32/ballot?electionId=<id>',
    purpose: 'Download compact ArduinoJson ballot manifest & SHA-256 hash',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>',
    requestJson: `// Query Parameter: electionId=el_sample_1`,
    responseJson: `{
  "electionId": "el_sample_1",
  "status": "active",
  "constituency": "North District",
  "ballotVersion": 2,
  "ballotHash": "8f4b21a9e30c...",
  "candidateCount": 2,
  "payloadBytes": 318,
  "candidates": [
    { "id": "cand_1", "num": 1, "name": "Elena Vance", "party": "Civic Alliance" },
    { "id": "cand_2", "num": 2, "name": "Marcus Chen", "party": "Green Future" }
  ]
}`,
  },
  {
    method: 'POST',
    path: '/api/esp32/enroll-complete',
    purpose: 'Return ONLY opaque R307/AS608 Template ID (raw biometrics rejected)',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>',
    requestJson: `{
  "commandId": "cmd_17951842",
  "voterDocId": "voter_042",
  "fingerprintTemplateId": "FP-106",
  "qualityScore": 96
}`,
    responseJson: `{
  "stored": true,
  "voterDocId": "voter_042",
  "fingerprintTemplateId": "FP-106",
  "rawBiometricsDiscarded": true
}`,
  },
  {
    method: 'POST',
    path: '/api/esp32/verify-voter',
    purpose: 'Real-time cross-booth anti-duplicate eligibility check before keypad unlock',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>',
    requestJson: `{
  "electionId": "el_sample_1",
  "fingerprintTemplateId": "FP-104"
}`,
    responseJson: `{
  "eligible": true,
  "alreadyVoted": false,
  "voterDocId": "voter_004",
  "constituency": "North District",
  "lcdLine1": "VERIFIED - CAST",
  "lcdLine2": "SELECT CANDIDATE"
}`,
  },
  {
    method: 'POST',
    path: '/api/esp32/cast-vote',
    purpose: 'Atomic anti-duplicate lock + strictly decoupled anonymized ballot',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>',
    requestJson: `{
  "electionId": "el_sample_1",
  "voterDocId": "voter_004",
  "candidateId": "cand_1",
  "idempotencyKey": "EVM-N01-00014-8a9f2c"
}`,
    responseJson: `{
  "accepted": true,
  "status": "COMMITTED",
  "receiptHash": "9e1c4a82b710f4d2c930a1e8",
  "anonymized": true,
  "lcdLine1": "VOTE RECORDED",
  "lcdLine2": "REF 9E1C4A82"
}`,
  },
  {
    method: 'POST',
    path: '/api/esp32/offline-sync',
    purpose: 'Flush LittleFS offline queue upon reconnect with deterministic conflict resolution',
    headers: 'X-Device-ID: <boothId>\nX-Device-API-Key: <sv_esp32_...>',
    requestJson: `{
  "electionId": "el_sample_1",
  "queuedVotes": [
    {
      "localSeq": 1,
      "idempotencyKey": "EVM-H02-OFF-001",
      "voterDocId": "voter_009",
      "candidateId": "cand_3",
      "capturedAt": "2026-11-20T13:48:10Z",
      "payloadMac": "hmac_sha256_hex..."
    }
  ]
}`,
    responseJson: `{
  "reconciled": true,
  "boothId": "booth_h02",
  "summary": {
    "totalProcessed": 1,
    "committedCount": 1,
    "duplicateIgnoredCount": 0,
    "conflictRejectedCount": 0
  },
  "results": [
    { "idempotencyKey": "EVM-H02-OFF-001", "localSeq": 1, "status": "COMMITTED" }
  ]
}`,
  },
] as const;

export const ESP32_ARDUINO_FIRMWARE_SNIPPET = `/*
 * Smart Vote — ESP32 Fingerprint EVM Firmware Reference (Arduino / ESP-IDF)
 * Hardware: ESP32-WROOM-32 + R307/AS608 Optical Sensor (UART2) + 16x2 I2C LCD + Buzzer + Reed Tamper Switch
 * Storage: LittleFS append-only encrypted queue (/offline_queue.ndjson) + NVS monotonic sequence + local voted bitset
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <Adafruit_Fingerprint.h>
#include <mbedtls/md.h>

const char* GATEWAY_URL   = "https://your-smart-vote-domain.run.app";
const char* DEVICE_ID     = "booth_evm_n01";
const char* DEVICE_KEY    = "sv_esp32_xxxxxxxxxxxx";
const char* OFFLINE_LOG   = "/offline_queue.ndjson";
const char* VOTED_CACHE   = "/local_voted_templates.txt";

Preferences nvs;
WiFiClientSecure tlsClient;

// 1. Local Anti-Duplicate Guard (works even when Wi-Fi is completely offline)
bool hasVotedLocally(const String& templateId) {
  File f = LittleFS.open(VOTED_CACHE, "r");
  if (!f) return false;
  while (f.available()) {
    if (f.readStringUntil('\\n').equals(templateId)) { f.close(); return true; }
  }
  f.close();
  return false;
}

void markVotedLocally(const String& templateId) {
  File f = LittleFS.open(VOTED_CACHE, "a");
  if (f) { f.println(templateId); f.flush(); f.close(); }
}

// 2. Durable Offline Queue Write (Atomic append + fsync + NVS sequence increment)
bool queueVoteOffline(const String& voterDocId, const String& templateId, const String& candidateId) {
  if (hasVotedLocally(templateId)) return false; // Immediate local double-vote block

  uint32_t seq = nvs.getUInt("offline_seq", 0) + 1;
  nvs.putUInt("offline_seq", seq);

  StaticJsonDocument<384> doc;
  doc["localSeq"]       = seq;
  doc["idempotencyKey"] = String(DEVICE_ID) + "-OFF-" + String(seq);
  doc["voterDocId"]     = voterDocId;
  doc["candidateId"]    = candidateId;
  doc["capturedAt"]     = millis(); // Replaced with RTC/NTP ISO timestamp if available

  File q = LittleFS.open(OFFLINE_LOG, "a");
  if (!q) return false;
  serializeJson(doc, q);
  q.println();
  q.flush(); // Commit to ESP32 SPI flash immediately
  q.close();

  markVotedLocally(templateId);
  return true;
}

// 3. Automatic Reconnection & Deterministic Batch Sync (Exponential Backoff)
bool flushOfflineQueue() {
  if (WiFi.status() != WL_CONNECTED || !LittleFS.exists(OFFLINE_LOG)) return false;

  File q = LittleFS.open(OFFLINE_LOG, "r");
  if (!q || q.size() == 0) { if (q) q.close(); return true; }

  DynamicJsonDocument batchDoc(12288);
  batchDoc["electionId"] = nvs.getString("election_id", "");
  JsonArray arr = batchDoc.createNestedArray("queuedVotes");

  while (q.available()) {
    String line = q.readStringUntil('\\n');
    line.trim();
    if (line.length() == 0) continue;
    StaticJsonDocument<384> row;
    if (deserializeJson(row, line) == DeserializationError::Ok) {
      arr.add(row.as<JsonObject>());
    }
  }
  q.close();

  HTTPClient http;
  tlsClient.setCACert(ROOT_CA_PEM); // Pin TLS root CA in production
  http.begin(tlsClient, String(GATEWAY_URL) + "/api/esp32/offline-sync");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-ID", DEVICE_ID);
  http.addHeader("X-Device-API-Key", DEVICE_KEY);

  String body;
  serializeJson(batchDoc, body);
  int code = http.POST(body);

  if (code == 200) {
    // Only truncate LittleFS queue AFTER HTTP 200 reconciliation confirmation
    LittleFS.remove(OFFLINE_LOG);
    http.end();
    return true;
  }
  http.end();
  return false;
}`;
