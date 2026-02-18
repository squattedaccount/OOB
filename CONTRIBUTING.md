# Contributing to Open Order Book

Thanks for your interest in contributing! The Open Order Book is open source and welcomes contributions from everyone.

## Getting Started

```bash
git clone https://github.com/openorderbook/sdk.git
cd sdk
npm install
```

## Project Structure

```
oob-sdk/          ← You are here (SDK + docs)
├── src/           ← SDK source code
│   ├── index.ts   ← Public exports
│   ├── types.ts   ← Types and constants
│   ├── api.ts     ← REST API client
│   ├── seaport.ts ← Seaport contract interactions
│   └── client.ts  ← Main OpenOrderBook class
├── docs/          ← Documentation
│   ├── api-reference.md
│   ├── integration-guide.md
│   └── architecture.md
└── dist/          ← Built output (git-ignored)

oob-api/           ← API worker (separate directory)
├── src/
│   ├── index.ts   ← Router
│   ├── routes/    ← Route handlers
│   ├── db.ts      ← Database client
│   └── response.ts← Response helpers
└── wrangler.toml  ← Cloudflare config
```

## Development

### SDK

```bash
cd oob-sdk
npm run check    # Type check (no emit)
npm run build    # Build ESM + CJS + declarations
npm run dev      # Watch mode
npm run test     # Run tests
```

### API Worker

```bash
cd oob-api
npm run check    # Type check
npm run dev      # Local dev server (wrangler)
```

## Guidelines

- **TypeScript** — All code is TypeScript. No `any` unless absolutely necessary.
- **No unnecessary dependencies** — The SDK has only `viem` as a peer dependency. Keep it that way.
- **Backward compatible** — Don't break existing API contracts or SDK method signatures without a major version bump.
- **Test your changes** — Add tests for new functionality.
- **Document your changes** — Update the relevant docs if you add or change API endpoints or SDK methods.

## Pull Request Process

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm run check` and `npm run build` to verify
5. Submit a PR with a clear description of what and why

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Chain ID and any relevant order hashes

## Code of Conduct

Be respectful. We're all here to build better NFT infrastructure and a more open internet. 
