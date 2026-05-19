#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseHost = Bun.env.STUTTER_HOST ?? "127.0.0.1";
const serverHost = Bun.env.STUTTER_SERVER_HOST ?? baseHost;
const webHost = Bun.env.STUTTER_WEB_HOST ?? baseHost;
const serverPort = Bun.env.STUTTER_SERVER_PORT ?? Bun.env.PORT ?? "8787";
const webPort = Bun.env.STUTTER_WEB_PORT ?? "1421";
const serverUrl = Bun.env.VITE_STUTTER_SERVER_URL ?? `http://${serverHost}:${serverPort}`;
const webUrl = `http://${webHost}:${webPort}`;

type NamedProcess = {
  name: string;
  process: Bun.Subprocess<"inherit", "inherit", "inherit">;
};

const children: NamedProcess[] = [];
let shuttingDown = false;

if (!existsSync(resolve(rootDir, "node_modules"))) {
  console.warn("node_modules is missing. Run `bun install` before starting local development.");
}

console.log("Starting local development setup");
console.log(`- web:    ${webUrl}`);
console.log(`- server: ${serverUrl}`);
console.log("");

start("server", ["bun", "--filter", "@stutter-tracker/server", "dev"], {
  PORT: serverPort,
});

start(
  "web",
  ["bun", "--filter", "@stutter-tracker/web", "dev", "--", "--host", webHost, "--port", webPort],
  {
    VITE_STUTTER_SERVER_URL: serverUrl,
  },
);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const firstExit = await Promise.race(
  children.map((child) =>
    child.process.exited.then((code) => ({
      code,
      name: child.name,
    })),
  ),
);

if (!shuttingDown) {
  console.error(
    `${firstExit.name} exited with code ${firstExit.code}; stopping local development setup.`,
  );
  await shutdown(firstExit.code ?? 1);
}

function start(name: string, cmd: string[], env: Record<string, string>) {
  const child = Bun.spawn({
    cmd,
    cwd: rootDir,
    env: {
      ...Bun.env,
      ...env,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push({ name, process: child });
}

async function shutdown(exitCode: number) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    child.process.kill();
  }

  await Promise.allSettled(children.map((child) => child.process.exited));
  process.exit(exitCode);
}
