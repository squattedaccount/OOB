#!/usr/bin/env npx tsx
/**
 * OOB Indexer — Near-Real-Time Goldsky Sync Watcher
 *
 * Runs sync-goldsky-pipelines.ts on an interval with debounced change detection.
 * Uses a state file signature so no-op runs are cheap (DB read only, no apply).
 *
 * This avoids GitHub Actions and works on free tier setups:
 * - run locally in a tmux/screen session, or
 * - run on a tiny always-on host/container.
 */

import { execSync } from "node:child_process";

const POLL_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.GOLDSKY_SYNC_POLL_MS || "60000"),
);
const DEBOUNCE_MS = Math.max(
  10_000,
  Number(process.env.GOLDSKY_SYNC_DEBOUNCE_MS || "30000"),
);
const STATE_FILE =
  process.env.GOLDSKY_SYNC_STATE_FILE || ".cache/goldsky-sync-state.txt";

let running = false;
let pendingSince = 0;
let shouldRunAfterCurrent = false;

function nowIso(): string {
  return new Date().toISOString();
}

function runSync(force = false): void {
  const args = [
    "npx",
    "tsx",
    "scripts/sync-goldsky-pipelines.ts",
    `--state-file=${STATE_FILE}`,
  ];
  if (force) args.push("--force");

  const cmd = args.join(" ");
  console.log(`[${nowIso()}] Running: ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function tick(): Promise<void> {
  if (running) {
    shouldRunAfterCurrent = true;
    return;
  }

  const now = Date.now();
  if (pendingSince === 0) {
    pendingSince = now;
    return;
  }

  if (now - pendingSince < DEBOUNCE_MS) {
    return;
  }

  running = true;
  pendingSince = 0;

  try {
    runSync(false);
  } catch (err) {
    console.error(`[${nowIso()}] sync failed:`, err);
  } finally {
    running = false;
    if (shouldRunAfterCurrent) {
      shouldRunAfterCurrent = false;
      pendingSince = Date.now();
    }
  }
}

async function main(): Promise<void> {
  console.log("=== OOB Indexer — Goldsky Near-Real-Time Watcher ===");
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`Debounce:      ${DEBOUNCE_MS}ms`);
  console.log(`State file:    ${STATE_FILE}`);

  // First sync immediately at startup
  try {
    runSync(true);
  } catch (err) {
    console.error(`[${nowIso()}] initial sync failed:`, err);
  }

  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
