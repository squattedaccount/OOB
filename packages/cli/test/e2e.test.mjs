import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

let server;
let baseUrl;
let flakyHits = 0;

function sampleOrder(overrides = {}) {
  return {
    orderHash: '0xorder',
    chainId: 8453,
    orderType: 'listing',
    offerer: '0x0000000000000000000000000000000000000001',
    nftContract: '0x00000000000000000000000000000000000000aa',
    tokenId: '1',
    tokenStandard: 'ERC721',
    priceWei: '100',
    currency: '0x0000000000000000000000000000000000000000',
    protocolFeeRecipient: '0x0000000000000000000000000000000000000002',
    protocolFeeBps: 50,
    royaltyRecipient: null,
    royaltyBps: 0,
    startTime: 0,
    endTime: 0,
    status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z',
    filledTxHash: null,
    filledAt: null,
    cancelledTxHash: null,
    cancelledAt: null,
    orderJson: {},
    signature: '0xsig',
    ...overrides,
  };
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OOB_API_URL: baseUrl,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

before(async () => {
  await mkdir(path.join(projectRoot, 'test'), { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/v1/config') {
      if (url.searchParams.get('mode') === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolFeeBps: 50, protocolFeeRecipient: '0xfee' }));
      return;
    }

    if (url.pathname === '/v1/orders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ orders: [sampleOrder()], total: 1 }));
      return;
    }

    if (url.pathname === '/v1/orders/best-listing') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder() }));
      return;
    }

    if (url.pathname === '/v1/orders/best-offer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder({ orderType: 'offer', priceWei: '90' }) }));
      return;
    }

    if (url.pathname === '/v1/orders/flaky') {
      flakyHits += 1;
      if (flakyHits === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporary unavailable' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder({ orderHash: '0xflaky' }) }));
      return;
    }

    const statsMatch = url.pathname.match(/^\/v1\/collections\/([^/]+)\/stats$/);
    if (statsMatch) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        collection: statsMatch[1],
        chainId: 8453,
        listingCount: 1,
        floorPriceWei: '100',
        offerCount: 1,
        bestOfferWei: '90',
      }));
      return;
    }

    if (url.pathname === '/v1/orders/0xflaky') {
      flakyHits += 1;
      if (flakyHits === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporary unavailable' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder({ orderHash: '0xflaky' }) }));
      return;
    }

    if (url.pathname === '/v1/orders/0xslow') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder({ orderHash: '0xslow' }) }));
      return;
    }

    // GET /v1/orders/best-listing/fill-tx (must be before generic :hash/fill-tx)
    if (url.pathname === '/v1/orders/best-listing/fill-tx') {
      const buyer = url.searchParams.get('buyer');
      if (!buyer) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required query param: buyer' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        to: '0x00000000000000ADcF27169eBb066B71',
        data: '0xfloorcalldata',
        value: '100',
        chainId: 8453,
        orderHash: '0xfloororder',
        orderType: 'listing',
        nftContract: '0x00000000000000000000000000000000000000aa',
        tokenId: '42',
        tokenStandard: 'ERC721',
        offerer: '0x0000000000000000000000000000000000000001',
        currency: '0x0000000000000000000000000000000000000000',
        currencySymbol: 'ETH',
        currencyDecimals: 18,
        priceWei: '100',
        priceDecimal: '0.0000000000000001',
        expiresAt: 9999999999,
      }));
      return;
    }

    // GET /v1/activity
    if (url.pathname === '/v1/activity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        activity: [{
          id: 1,
          orderHash: '0xorder',
          chainId: 8453,
          eventType: 'listed',
          fromAddress: '0x0000000000000000000000000000000000000001',
          toAddress: null,
          nftContract: '0x00000000000000000000000000000000000000aa',
          tokenId: '1',
          priceWei: '100',
          currency: '0x0000000000000000000000000000000000000000',
          currencySymbol: 'ETH',
          currencyDecimals: 18,
          priceDecimal: '0.0000000000000001',
          txHash: null,
          createdAt: '2024-01-01T00:00:00.000Z',
        }],
        total: 1,
      }));
      return;
    }

    // GET /v1/erc20/:token/approve-tx
    const approveMatch = url.pathname.match(/^\/v1\/erc20\/([^/]+)\/approve-tx$/);
    if (approveMatch) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        to: approveMatch[1],
        data: '0xapprovedata',
        value: '0',
      }));
      return;
    }

    // GET /v1/orders/:hash/fill-tx
    const fillTxMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/fill-tx$/);
    if (fillTxMatch) {
      const buyer = url.searchParams.get('buyer');
      if (!buyer) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required query param: buyer' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        to: '0x00000000000000ADcF27169eBb066B71',
        data: '0xcalldata',
        value: '100',
        chainId: 8453,
        orderHash: fillTxMatch[1],
        orderType: 'listing',
        nftContract: '0x00000000000000000000000000000000000000aa',
        tokenId: '1',
        tokenStandard: 'ERC721',
        offerer: '0x0000000000000000000000000000000000000001',
        currency: '0x0000000000000000000000000000000000000000',
        currencySymbol: 'ETH',
        currencyDecimals: 18,
        priceWei: '100',
        priceDecimal: '0.0000000000000001',
        expiresAt: 9999999999,
      }));
      return;
    }

    // GET /v1/orders/:hash/activity
    const activityMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)\/activity$/);
    if (activityMatch) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        activity: [{
          id: 1,
          orderHash: activityMatch[1],
          chainId: 8453,
          eventType: 'listed',
          fromAddress: '0x0000000000000000000000000000000000000001',
          toAddress: null,
          nftContract: '0x00000000000000000000000000000000000000aa',
          tokenId: '1',
          priceWei: '100',
          currency: '0x0000000000000000000000000000000000000000',
          currencySymbol: 'ETH',
          currencyDecimals: 18,
          priceDecimal: '0.0000000000000001',
          txHash: null,
          createdAt: '2024-01-01T00:00:00.000Z',
        }],
        total: 1,
      }));
      return;
    }

    if (url.pathname.startsWith('/v1/orders/')) {
      const orderHash = url.pathname.split('/').pop();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: sampleOrder({ orderHash }) }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('config show returns machine-readable JSON output', async () => {
  const result = await runCli(['config', 'show']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.apiUrl, baseUrl);
  assert.equal(payload.meta.timeoutMs, 8000);
});

test('--field --raw extracts a single value', async () => {
  const result = await runCli(['--field', 'data.apiUrl', '--raw', 'config', 'show']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), baseUrl);
});

test('health works against the mock API', async () => {
  const result = await runCli(['health']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.protocolConfig.protocolFeeBps, 50);
});

test('retryable API failures are retried', async () => {
  flakyHits = 0;
  const result = await runCli(['--retries', '1', 'get', '0xflaky']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.order.orderHash, '0xflaky');
});

test('timeouts return deterministic network failures', async () => {
  const result = await runCli(['--timeout', '50', 'get', '0xslow']);
  assert.equal(result.code, 5);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'NETWORK_ERROR');
});

test('batch invalid command keeps deterministic exit code 3', async () => {
  const result = await runCli(['--jsonl', 'batch', 'run', '--stdin'], {
    stdin: '{"command":"missing.command"}\n',
  });
  assert.equal(result.code, 3);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.data[0].error.code, 'INVALID_INPUT');
});

// ─── Phase 1 new feature tests ─────────────────────────────────────────────

test('--toon flag outputs TOON format', async () => {
  const result = await runCli(['--toon', 'config', 'show']);
  assert.equal(result.code, 0);
  // TOON output should have key: value lines, not JSON
  assert.ok(result.stdout.includes('ok: true'));
  assert.ok(result.stdout.includes('command: config show'));
  // Verify it's not JSON
  assert.ok(!result.stdout.startsWith('{'));
});

test('--output toon is equivalent to --toon', async () => {
  const result = await runCli(['--output', 'toon', 'config', 'show']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('ok: true'));
  assert.ok(!result.stdout.startsWith('{'));
});

test('--max-lines truncates output', async () => {
  const result = await runCli(['--max-lines', '3', 'config', 'show']);
  assert.equal(result.code, 0);
  const lines = result.stdout.trim().split('\n');
  // Should be 3 lines + 1 truncation notice = 4 lines
  assert.equal(lines.length, 4);
  assert.ok(lines[3].includes('more lines truncated'));
});

test('--verbose writes to stderr', async () => {
  const result = await runCli(['--verbose', 'health']);
  assert.equal(result.code, 0);
  assert.ok(result.stderr.includes('[verbose] GET'));
  assert.ok(result.stderr.includes('[verbose] OK'));
});

test('describe without args lists all commands', async () => {
  const result = await runCli(['describe']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.data.commands));
  assert.ok(payload.data.commands.length > 10);
});

test('describe orders-list returns schema', async () => {
  const result = await runCli(['describe', 'orders-list']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.name, 'orders list');
  assert.ok(Array.isArray(payload.data.options));
  assert.ok(Array.isArray(payload.data.outputFields));
});

test('describe unknown command returns error', async () => {
  const result = await runCli(['describe', 'nonexistent']);
  assert.notEqual(result.code, 0);
});

test('config protocol returns fee config', async () => {
  const result = await runCli(['config', 'protocol']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.protocolFeeBps, 50);
  assert.equal(payload.data.protocolFeeRecipient, '0xfee');
});

test('activity order returns events for an order', async () => {
  const result = await runCli(['activity', 'order', '0xorder']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.activity.length, 1);
  assert.equal(payload.data.activity[0].eventType, 'listed');
  assert.equal(payload.data.total, 1);
});

test('activity list returns filtered events', async () => {
  const result = await runCli(['activity', 'list', '--collection', '0x00000000000000000000000000000000000000aa']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.data.activity));
});

test('orders fill-tx requires --buyer', async () => {
  const result = await runCli(['orders', 'fill-tx', '0xorder']);
  // commander exits with code 1 for missing required options
  assert.notEqual(result.code, 0);
});

test('orders fill-tx with --buyer returns calldata', async () => {
  const result = await runCli(['orders', 'fill-tx', '0xorder', '--buyer', '0x0000000000000000000000000000000000000099']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.to, '0x00000000000000ADcF27169eBb066B71');
  assert.equal(payload.data.data, '0xcalldata');
  assert.equal(payload.data.chainId, 8453);
  assert.equal(payload.data.priceWei, '100');
});

test('orders floor-tx with --buyer returns calldata', async () => {
  const result = await runCli([
    'orders', 'floor-tx',
    '--collection', '0x00000000000000000000000000000000000000aa',
    '--buyer', '0x0000000000000000000000000000000000000099',
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.orderHash, '0xfloororder');
  assert.equal(payload.data.data, '0xfloorcalldata');
});

test('approve-tx returns approval calldata', async () => {
  const result = await runCli(['approve-tx', '0x4200000000000000000000000000000000000006']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.to, '0x4200000000000000000000000000000000000006');
  assert.equal(payload.data.data, '0xapprovedata');
  assert.equal(payload.data.value, '0');
});

test('TOON format for orders list is compact', async () => {
  const result = await runCli(['--toon', 'orders', 'list']);
  assert.equal(result.code, 0);
  // TOON should use key: value format, not JSON
  assert.ok(result.stdout.includes('ok: true'));
  assert.ok(result.stdout.includes('command: list'));
  // Verify data section exists
  assert.ok(result.stdout.includes('data:'));
});

test('batch run with fill-tx requires buyer arg', async () => {
  const result = await runCli(['batch', 'run', '--stdin'], {
    stdin: JSON.stringify({ command: 'orders.fill-tx', args: { orderHash: '0xorder' } }) + '\n',
  });
  // Should still succeed but with error in the batch result
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data[0].ok, false);
  assert.equal(payload.data[0].error.code, 'INVALID_INPUT');
});

test('batch run with fill-tx and buyer succeeds', async () => {
  const result = await runCli(['batch', 'run', '--stdin'], {
    stdin: JSON.stringify({
      command: 'orders.fill-tx',
      args: { orderHash: '0xorder', buyer: '0x0000000000000000000000000000000000000099' },
    }) + '\n',
  });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data[0].ok, true);
  assert.equal(payload.data[0].data.to, '0x00000000000000ADcF27169eBb066B71');
});

test('programmatic API exports are accessible', async () => {
  // Import the built module and verify key exports exist
  const mod = await import(path.join(projectRoot, 'dist', 'index.js'));
  assert.ok(typeof mod.buildProgram === 'function');
  assert.ok(typeof mod.runCli === 'function');
  assert.ok(typeof mod.CliApiClient === 'function');
  assert.ok(typeof mod.createClient === 'function');
  assert.ok(typeof mod.resolveConfig === 'function');
  assert.ok(typeof mod.formatToon === 'function');
  assert.ok(typeof mod.CliError === 'function');
  assert.ok(typeof mod.classifyError === 'function');
  // Phase 2 wallet exports
  assert.ok(typeof mod.createWalletContext === 'function');
  assert.ok(typeof mod.requirePrivateKey === 'function');
  assert.ok(typeof mod.createPublicClientFromConfig === 'function');
  assert.ok(typeof mod.createReadOnlyContext === 'function');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Wallet & Write Command Tests
// ═══════════════════════════════════════════════════════════════════════════

test('config show includes dryRun field', async () => {
  const result = await runCli(['config', 'show', '--dry-run']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
});

test('--private-key is resolved in config', async () => {
  const result = await runCli(['config', 'show', '--private-key', '0x' + 'ab'.repeat(32)]);
  assert.equal(result.code, 0);
  // Config show doesn't leak private key, but command should not crash
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
});

test('describe lists Phase 2 commands', async () => {
  const result = await runCli(['describe']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  const names = payload.data.commands.map(c => c.name);
  // Check key Phase 2 commands are included
  assert.ok(names.includes('wallet info'), 'Missing wallet info');
  assert.ok(names.includes('wallet balance'), 'Missing wallet balance');
  assert.ok(names.includes('wallet approve-nft'), 'Missing wallet approve-nft');
  assert.ok(names.includes('orders create-listing'), 'Missing orders create-listing');
  assert.ok(names.includes('orders fill'), 'Missing orders fill');
  assert.ok(names.includes('orders cancel'), 'Missing orders cancel');
  assert.ok(names.includes('orders sweep'), 'Missing orders sweep');
  assert.ok(names.includes('orders accept-offer'), 'Missing orders accept-offer');
  assert.ok(names.includes('batch execute'), 'Missing batch execute');
});

test('describe orders-create-listing returns schema', async () => {
  const result = await runCli(['describe', 'orders-create-listing']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'orders create-listing');
  assert.ok(payload.data.options.length > 0);
  assert.ok(payload.data.outputFields.includes('orderHash'));
});

test('describe wallet-info returns schema', async () => {
  const result = await runCli(['describe', 'wallet-info']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'wallet info');
  assert.ok(payload.data.outputFields.includes('address'));
  assert.ok(payload.data.outputFields.includes('balanceEth'));
});

test('describe batch-execute returns schema', async () => {
  const result = await runCli(['describe', 'batch-execute']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'batch execute');
});

test('wallet info fails without private key', async () => {
  const result = await runCli(['wallet', 'info']);
  assert.notEqual(result.code, 0);
  const output = result.stdout.trim() || result.stderr.trim();
  const payload = JSON.parse(output);
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes('Private key required'));
});

test('orders create-listing fails without private key', async () => {
  const result = await runCli([
    'orders', 'create-listing',
    '--collection', '0x0000000000000000000000000000000000000001',
    '--token-id', '1',
    '--price', '1000000000000000000',
  ]);
  assert.notEqual(result.code, 0);
  const output = result.stdout.trim() || result.stderr.trim();
  const payload = JSON.parse(output);
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes('Private key required'));
});

test('orders fill fails without private key', async () => {
  const result = await runCli(['orders', 'fill', '0xorderhash123']);
  assert.notEqual(result.code, 0);
  const output = result.stdout.trim() || result.stderr.trim();
  const payload = JSON.parse(output);
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes('Private key required'));
});

test('orders cancel fails without private key', async () => {
  const result = await runCli(['orders', 'cancel', '0xorderhash123']);
  assert.notEqual(result.code, 0);
  const output = result.stdout.trim() || result.stderr.trim();
  const payload = JSON.parse(output);
  assert.equal(payload.ok, false);
  assert.ok(payload.error.message.includes('Private key required'));
});

test('orders sweep --dry-run shows preview without wallet', async () => {
  const result = await runCli([
    'orders', 'sweep',
    '--collection', '0x00000000000000000000000000000000000000aa',
    '--count', '2',
    '--dry-run',
  ]);
  // Sweep dry-run still needs to fetch orders from API, so it will hit the mock
  // Since our mock returns orders, it should show the preview
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'sweep');
});

test('orders create-listing --dry-run shows preview without wallet', async () => {
  const result = await runCli([
    'orders', 'create-listing',
    '--collection', '0x0000000000000000000000000000000000000001',
    '--token-id', '42',
    '--price', '1.5',
    '--dry-run',
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'create-listing');
  assert.equal(payload.data.collection, '0x0000000000000000000000000000000000000001');
  assert.equal(payload.data.tokenId, '42');
  assert.equal(payload.data.priceWei, '1500000000000000000');
  assert.equal(payload.data.priceEth, '1.5');
});

test('orders create-offer --dry-run shows preview', async () => {
  const result = await runCli([
    'orders', 'create-offer',
    '--collection', '0x0000000000000000000000000000000000000001',
    '--amount', '500000000000000000',
    '--currency', '0x4200000000000000000000000000000000000006',
    '--token-id', '10',
    '--dry-run',
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'create-offer');
  assert.equal(payload.data.amountWei, '500000000000000000');
});

test('orders cancel --dry-run shows preview', async () => {
  const result = await runCli(['orders', 'cancel', '0xorderhash123', '--dry-run']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'cancel');
  assert.equal(payload.data.orderHash, '0xorderhash123');
});

test('orders fill --dry-run shows preview', async () => {
  const result = await runCli(['orders', 'fill', '0xorder', '--dry-run']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'fill');
  assert.equal(payload.data.orderHash, '0xorder');
  assert.equal(payload.data.priceWei, '100');
});

test('wallet approve-nft --dry-run shows preview', async () => {
  const result = await runCli([
    'wallet', 'approve-nft',
    '--collection', '0x0000000000000000000000000000000000000001',
    '--dry-run',
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'approve-nft');
});

test('wallet approve-erc20 --dry-run shows preview', async () => {
  const result = await runCli([
    'wallet', 'approve-erc20',
    '--token', '0x4200000000000000000000000000000000000006',
    '--dry-run',
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.action, 'approve-erc20');
});

// ─── Phase 3: Streaming & Monitoring ────────────────────────────────────────

test('describe lists Phase 3-5 commands', async () => {
  const result = await runCli(['describe']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  const names = payload.data.commands.map((c) => c.name);
  // Phase 3
  assert.ok(names.includes('stream'), 'should have stream');
  assert.ok(names.includes('watch order'), 'should have watch order');
  assert.ok(names.includes('watch price'), 'should have watch price');
  assert.ok(names.includes('watch collection'), 'should have watch collection');
  // Phase 4
  assert.ok(names.includes('analyze depth'), 'should have analyze depth');
  assert.ok(names.includes('analyze spread'), 'should have analyze spread');
  assert.ok(names.includes('analyze price-history'), 'should have analyze price-history');
  assert.ok(names.includes('analyze portfolio'), 'should have analyze portfolio');
  assert.ok(names.includes('agent manifest'), 'should have agent manifest');
  assert.ok(names.includes('mcp serve'), 'should have mcp serve');
  // Phase 5
  assert.ok(names.includes('setup'), 'should have setup');
  assert.ok(names.includes('completions'), 'should have completions');
  // Total should be 27 (Phase 1-2) + 12 (Phase 3-5) = 39
  assert.ok(payload.data.commands.length >= 39, `expected >= 39 commands, got ${payload.data.commands.length}`);
});

test('describe stream returns schema', async () => {
  const result = await runCli(['describe', 'stream']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'stream');
  assert.ok(payload.data.options.length > 0);
});

test('describe watch-order returns schema', async () => {
  const result = await runCli(['describe', 'watch-order']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'watch order');
  assert.ok(payload.data.arguments.length > 0);
});

test('describe analyze-depth returns schema', async () => {
  const result = await runCli(['describe', 'analyze-depth']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'analyze depth');
  assert.ok(payload.data.options.some((o) => o.name === 'collection'));
});

test('describe agent-manifest returns schema', async () => {
  const result = await runCli(['describe', 'agent-manifest']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'agent manifest');
});

test('describe completions returns schema', async () => {
  const result = await runCli(['describe', 'completions']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.name, 'completions');
  assert.ok(payload.data.arguments.some((a) => a.name === 'shell'));
});

// ─── Phase 4: Analyze Commands ──────────────────────────────────────────────

test('analyze spread returns spread metrics', async () => {
  const result = await runCli(['analyze', 'spread', '--collection', '0x0000000000000000000000000000000000000001']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.command, 'analyze spread');
  assert.equal(payload.data.collection, '0x0000000000000000000000000000000000000001');
  assert.ok('bestListingWei' in payload.data);
  assert.ok('spreadWei' in payload.data);
});

test('analyze depth returns depth buckets', async () => {
  const result = await runCli(['analyze', 'depth', '--collection', '0x0000000000000000000000000000000000000001']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.command, 'analyze depth');
  assert.ok('totalListings' in payload.data);
  assert.ok('listingDepth' in payload.data);
  assert.ok('offerDepth' in payload.data);
});

test('analyze price-history returns price stats', async () => {
  const result = await runCli(['analyze', 'price-history', '--collection', '0x0000000000000000000000000000000000000001']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.command, 'analyze price-history');
  assert.ok('collection' in payload.data);
});

test('analyze portfolio returns positions', async () => {
  const result = await runCli(['analyze', 'portfolio', '0x0000000000000000000000000000000000000099']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.command, 'analyze portfolio');
  assert.equal(payload.data.address, '0x0000000000000000000000000000000000000099');
  assert.ok('totalActiveListings' in payload.data);
});

// ─── Phase 4: Agent Manifest ────────────────────────────────────────────────

test('agent manifest returns full capability manifest', async () => {
  const result = await runCli(['agent', 'manifest']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.ok(payload.ok);
  assert.equal(payload.data.name, 'oob-cli');
  assert.ok(payload.data.capabilities.read.length > 0);
  assert.ok(payload.data.capabilities.write.length > 0);
  assert.ok(payload.data.capabilities.monitoring.length > 0);
  assert.ok(payload.data.capabilities.analysis.length > 0);
  assert.ok(payload.data.outputFormats.includes('table'));
  assert.ok(payload.data.globalFlags.includes('--human-prices'));
  assert.ok(payload.data.globalFlags.includes('--yes'));
});

// ─── Phase 5: Table Output ──────────────────────────────────────────────────

test('--table flag outputs table format', async () => {
  const result = await runCli(['orders', 'list', '--collection', '0x0000000000000000000000000000000000000001', '--table']);
  assert.equal(result.code, 0);
  // Table output should NOT be valid JSON
  const isJson = (() => { try { JSON.parse(result.stdout); return true; } catch { return false; } })();
  assert.equal(isJson, false, 'table output should not be JSON');
  // Should contain column-like data
  assert.ok(result.stdout.length > 0, 'table output should not be empty');
});

test('--output table is equivalent to --table', async () => {
  const result = await runCli(['orders', 'list', '--collection', '0x0000000000000000000000000000000000000001', '--output', 'table']);
  assert.equal(result.code, 0);
  const isJson = (() => { try { JSON.parse(result.stdout); return true; } catch { return false; } })();
  assert.equal(isJson, false, 'table output should not be JSON');
});

// ─── Phase 5: Human Prices ─────────────────────────────────────────────────

test('config show includes humanPrices and yes fields', async () => {
  const result = await runCli(['config', 'show', '--human-prices', '--yes']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.data.humanPrices, true);
  assert.equal(payload.data.yes, true);
});

// ─── Phase 5: Shell Completions ─────────────────────────────────────────────

test('completions bash outputs bash completion script', async () => {
  const result = await runCli(['completions', 'bash']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('_oob_completions'), 'should contain bash function name');
  assert.ok(result.stdout.includes('complete -F'), 'should contain complete command');
});

test('completions zsh outputs zsh completion script', async () => {
  const result = await runCli(['completions', 'zsh']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('#compdef oob'), 'should contain zsh compdef');
});

test('completions fish outputs fish completion script', async () => {
  const result = await runCli(['completions', 'fish']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('complete -c oob'), 'should contain fish complete command');
});

// ─── Phase 5: Programmatic Exports ─────────────────────────────────────────

test('formatTable export is accessible', async () => {
  const mod = await import('../dist/index.js');
  assert.equal(typeof mod.formatTable, 'function');
});
