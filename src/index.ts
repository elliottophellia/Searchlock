#!/usr/bin/env bun
import { VERSION, runHttp, runStdio } from "./server.ts";

function usage(code = 2): never {
  const out = `Usage: searchlock [--transport stdio|streamable-http] [--host H] [--port N]
       [--safesearch off|moderate|strict] [--ddg-region REGION]
       [--parse-mode text|main|markdown] [--allow-private-urls]
       [--version] [--help]`;
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}

const args = process.argv.slice(2);
let transport = "stdio";
let host = "127.0.0.1";
let port = 8000;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--transport") transport = args[++i] ?? usage();
  else if (arg === "--host") host = args[++i] ?? usage();
  else if (arg === "--port") port = Number(args[++i] ?? usage());
  else if (arg === "--safesearch") process.env["SEARCHLOCK_SAFESEARCH"] = args[++i] ?? usage();
  else if (arg === "--ddg-region") process.env["SEARCHLOCK_DDG_REGION"] = args[++i] ?? usage();
  else if (arg === "--parse-mode") process.env["SEARCHLOCK_PARSE_MODE"] = args[++i] ?? usage();
  else if (arg === "--allow-private-urls") process.env["SEARCHLOCK_ALLOW_PRIVATE_URLS"] = "1";
  else if (arg === "--version") {
    console.log(VERSION);
    process.exit(0);
  } else if (arg === "-h" || arg === "--help") usage(0);
  else usage();
}

if (transport === "stdio") {
  await runStdio();
} else if (transport === "streamable-http") {
  await runHttp(host, port);
} else {
  usage();
}
