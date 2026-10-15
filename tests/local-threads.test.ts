import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { assertApiDeploymentConfig, type Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;

const baseConfig = (overrides: Partial<Config> = {}): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".",
  agentBackend: "sample",
  intelligenceApiKey: undefined,
  allowLocalThreads: true,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  ...overrides,
});

const headers = () => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const request = (path: string, init?: RequestInit) =>
  server.app.request(path, { headers: headers(), ...init });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore({ dataDir: join(directory, "db") });
});

beforeEach(async () => {
  const config = baseConfig({ dataDir: directory });
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await session.json();
  assert.equal(session.status, 200, JSON.stringify(body));
  token = body.token;
});

after(async () => {
  await server?.agent.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("assertApiDeploymentConfig passes without an Intelligence key when local threads are allowed", () => {
  assertApiDeploymentConfig(baseConfig({ allowLocalThreads: true }));
});

test("assertApiDeploymentConfig still throws when local threads are disabled and the key is missing", () => {
  assert.throws(() => assertApiDeploymentConfig(baseConfig({ allowLocalThreads: false })));
});

test("workspace snapshot reports richThreads=false when no Intelligence key is configured", async () => {
  const response = await request("/api/workspace");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.runtime.richThreads, false);
  assert.equal(body.runtime.provider, "sample");
});

test("main-thread endpoint works without Intelligence and returns a locally stored thread", async () => {
  const response = await request("/api/main-thread");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.threadId, "main thread id is generated locally");
  assert.equal(body.existing, true);
});

test("copilotkit agent endpoint is reachable without Intelligence", async () => {
  // The sample agent needs a configured MODEL+key; the point of this test is that
  // the runtime handler is mounted and does NOT reject with a "missing Intelligence"
  // error — it reaches the agent code path (400/422/500 from the model layer, not 401).
  const response = await request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: { ...headers(), Accept: "text/event-stream" },
    body: JSON.stringify({ threadId: "t-local" }),
  });
  assert.ok(
    response.status !== 401 && response.status !== 404,
    `endpoint should be reachable, got ${response.status}`,
  );
});
