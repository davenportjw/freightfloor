#!/usr/bin/env node
import { runLiveSmoke } from './dist/live.js';

const lobbyUrl = process.argv[2] || process.env.LOBBY_URL || 'http://127.0.0.1:8080';
const driveDurationMs = process.env.SMOKE_DRIVE_MS
  ? Number(process.env.SMOKE_DRIVE_MS)
  : 10_000;
const cleanupFirestore = process.env.SMOKE_SKIP_FIRESTORE !== '1';

const report = await runLiveSmoke({
  lobbyUrl,
  driveDurationMs,
  cleanupFirestore,
});

process.exit(report.ok ? 0 : 1);
