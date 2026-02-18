import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_uIVZ6nBU0bes@ep-square-field-aikw734w-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const sql = postgres(DATABASE_URL);

try {
  await sql`CREATE TABLE IF NOT EXISTS webhook_dedup (dedup_key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE INDEX IF NOT EXISTS idx_webhook_dedup_created_at ON webhook_dedup (created_at)`;
  console.log("✅ Migration 003_webhook_dedup applied successfully");
} catch (e) {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
} finally {
  await sql.end();
}
