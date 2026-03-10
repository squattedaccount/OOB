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

    if (url.pathname === '/v1/collections/0x00000000000000000000000000000000000000aa/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        collection: '0x00000000000000000000000000000000000000aa',
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
