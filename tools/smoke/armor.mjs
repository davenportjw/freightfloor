#!/usr/bin/env node
import { runArmorSmoke } from './dist/armor.js';

const lobbyUrl = process.argv[2] || process.env.LOBBY_URL || 'http://127.0.0.1:8080';
const cleanupFirestore = process.env.SMOKE_SKIP_FIRESTORE !== '1';

const report = await runArmorSmoke({
  lobbyUrl,
  cleanupFirestore,
});

process.exit(report.ok ? 0 : 1);
