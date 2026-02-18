/**
 * OOB Indexer — Alchemy Webhook Setup Script
 *
 * Creates Alchemy Notify GraphQL webhooks that monitor Seaport v1.6 events
 * (OrderFulfilled, OrderCancelled, CounterIncremented) and send them to
 * the OOB indexer worker.
 *
 * Prerequisites:
 *   export ALCHEMY_NOTIFY_TOKEN=your_token_here
 *
 * Usage:
 *   npx tsx scripts/setup-alchemy-webhooks.ts
 *   npx tsx scripts/setup-alchemy-webhooks.ts --list
 *   npx tsx scripts/setup-alchemy-webhooks.ts --delete
 */

const ALCHEMY_NOTIFY_API = "https://dashboard.alchemy.com/api";

const SEAPORT_ADDRESS = "0x0000000000000068f116a894984e2db1123eb395";

const SEAPORT_EVENT_SIGNATURES = [
  // OrderFulfilled
  "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
  // OrderCancelled
  "0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d",
  // CounterIncremented
  "0x721c20121297512b72821b97f5326571674d3f0a0628f63e0a3aabf21bd67864",
];

// Chains with Alchemy support
const CHAINS = [
  { name: "Ethereum", network: "ETH_MAINNET", chainId: 1 },
  { name: "Base", network: "BASE_MAINNET", chainId: 8453 },
  { name: "Ronin", network: "RONIN_MAINNET", chainId: 2020 },
  { name: "Ronin Saigon", network: "RONIN_SAIGON", chainId: 202601 },
  // Add more as Alchemy adds support:
  // { name: "Abstract", network: "ABSTRACT_MAINNET", chainId: 2741 },
];

const INDEXER_URL =
  process.env.OOB_INDEXER_URL || "https://oob-indexer.sm-p.workers.dev";

// ─── Alchemy API Helpers ────────────────────────────────────────────────────

async function listWebhooks(token: string): Promise<any[]> {
  const res = await fetch(`${ALCHEMY_NOTIFY_API}/team-webhooks`, {
    headers: { "X-Alchemy-Token": token },
  });
  if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data as any).data || [];
}

async function createGraphQLWebhook(
  token: string,
  network: string,
  webhookUrl: string,
): Promise<any> {
  // GraphQL query that captures all three Seaport event types from the canonical address
  const graphqlQuery = `
{
  block {
    logs(filter: {addresses: ["${SEAPORT_ADDRESS}"], topics: [${SEAPORT_EVENT_SIGNATURES.map((s) => `"${s}"`).join(", ")}]}) {
      transaction {
        hash
      }
      topics
      data
      account {
        address
      }
    }
    number
    timestamp
  }
}
  `.trim();

  const res = await fetch(`${ALCHEMY_NOTIFY_API}/create-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Alchemy-Token": token,
    },
    body: JSON.stringify({
      network,
      webhook_type: "GRAPHQL",
      webhook_url: webhookUrl,
      graphql_query: graphqlQuery,
    }),
  });

  if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteWebhook(token: string, webhookId: string): Promise<void> {
  const res = await fetch(
    `${ALCHEMY_NOTIFY_API}/delete-webhook?webhook_id=${webhookId}`,
    {
      method: "DELETE",
      headers: { "X-Alchemy-Token": token },
    },
  );
  if (!res.ok) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.ALCHEMY_NOTIFY_TOKEN;
  if (!token) {
    console.error("❌ Set ALCHEMY_NOTIFY_TOKEN first");
    console.log("   Get it from: https://dashboard.alchemy.com/webhooks");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const shouldList = args.includes("--list");
  const shouldDelete = args.includes("--delete");

  console.log("=== OOB Indexer — Alchemy Webhook Setup ===\n");
  console.log(`Indexer URL: ${INDEXER_URL}`);
  console.log(`Seaport:     ${SEAPORT_ADDRESS}`);

  // List existing
  console.log("\n📋 Existing webhooks:");
  const webhooks = await listWebhooks(token);
  if (webhooks.length === 0) {
    console.log("  (none)");
  } else {
    for (const wh of webhooks) {
      console.log(`  ${wh.id}: ${wh.network} → ${wh.webhook_url} (active=${wh.is_active})`);
    }
  }

  if (shouldList) return;

  // Delete if requested
  if (shouldDelete) {
    const oobWebhooks = webhooks.filter((wh: any) =>
      wh.webhook_url?.includes("oob-indexer"),
    );
    if (oobWebhooks.length === 0) {
      console.log("\n  No OOB indexer webhooks to delete.");
    } else {
      console.log(`\n🗑️  Deleting ${oobWebhooks.length} OOB webhooks...`);
      for (const wh of oobWebhooks) {
        await deleteWebhook(token, wh.id);
        console.log(`  ✅ Deleted: ${wh.id}`);
      }
    }
    return;
  }

  // Create webhooks
  console.log("\n🚀 Creating webhooks...\n");

  for (const chain of CHAINS) {
    console.log(`  ${chain.name} (${chain.network})...`);
    try {
      const result = await createGraphQLWebhook(
        token,
        chain.network,
        `${INDEXER_URL}/webhook/alchemy`,
      );
      console.log(`  ✅ Created: ${(result as any).data?.id || "ok"}`);
    } catch (err) {
      console.error(`  ❌ Failed: ${err}`);
    }
  }

  console.log("\n=== Done ===");
  console.log(
    "\nWebhooks will POST Seaport events to:",
    `${INDEXER_URL}/webhook/alchemy`,
  );
  console.log(
    "Set WEBHOOK_SECRET on the indexer worker if you want verification.",
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
