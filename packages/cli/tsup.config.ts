import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  external: ["@oob/sdk", "viem", "viem/accounts", "viem/chains", "ws", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk/server/stdio.js"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
