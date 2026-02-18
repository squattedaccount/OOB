#!/usr/bin/env npx tsx
/**
 * Migration runner for OOB API database.
 * Reads SQL files from ../migrations/ in order and executes them.
 * Tracks applied migrations in a `_migrations` table.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const rows = await sql`SELECT name FROM _migrations ORDER BY name`;
  return new Set(rows.map((r: any) => r.name));
}

async function run(): Promise<void> {
  console.log("[migrate] Connecting to database...");
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  console.log(`[migrate] ${applied.size} migration(s) already applied`);

  const migrationsDir = join(import.meta.dirname ?? __dirname, "..", "migrations");
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let newCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] SKIP ${file} (already applied)`);
      continue;
    }

    const filePath = join(migrationsDir, file);
    const content = await readFile(filePath, "utf-8");

    console.log(`[migrate] APPLYING ${file}...`);
    try {
      // Split into individual statements (Neon serverless driver doesn't support
      // multiple statements in a single call). Strip comments and blank lines first.
      const statements = content
        .split(/;/)
        .map((s) => s.replace(/--[^\n]*/g, "").trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        await sql(stmt);
      }
      await sql`INSERT INTO _migrations (name) VALUES (${file})`;
      console.log(`[migrate] ✓ ${file} applied successfully`);
      newCount++;
    } catch (err: any) {
      console.error(`[migrate] ✗ ${file} FAILED:`, err.message);
      process.exit(1);
    }
  }

  if (newCount === 0) {
    console.log("[migrate] Database is up to date.");
  } else {
    console.log(`[migrate] Applied ${newCount} new migration(s).`);
  }
}

run().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
