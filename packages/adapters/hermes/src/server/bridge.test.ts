import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: vi.fn(),
}));
import { runAdapterExecutionTargetProcess, type AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { buildSshSpawnTarget } from "@paperclipai/adapter-utils/ssh";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { bridgeRemoteEnv } from "./bridge-execute.js";
import {
  BRIDGE_PROTOCOL, buildDescriptor, canonical, contentHash, mapBridgeResult,
  parseBridgeResult, parseStopEvidence, sha256, strictJson,
  type BridgeResult, type DispatchDescriptor, type JsonObject,
} from "./bridge-protocol.js";

function descriptor(): DispatchDescriptor {
  return buildDescriptor({
    controlInstance: "control-1", companyId: "company-1", agentId: "agent-1", runId: "run-1",
    taskRef: "task-1", prompt: "請精確保留\r\nbytes\n", deadline: "2030-01-01T00:00:00.000Z",
    remoteDirectory: "/bridge/prompt", params: { model: "model" }, workspacePolicySha256: "a".repeat(64), executionSlot: "slot-1",
  });
}
function sign(record: JsonObject): BridgeResult {
  return { ...record, result_sha256: contentHash(record, "result_sha256") } as BridgeResult;
}
function envelope(d: DispatchDescriptor, outcome = "succeeded", revision = 1, previous: string | null = null): BridgeResult {
  return sign({
    protocol: BRIDGE_PROTOCOL, schema_version: 1, attempt_key: d.attempt_key,
    dispatch_sha256: d.dispatch_sha256, run_id: d.run_id,
    result_revision: revision, previous_result_sha256: previous,
    state: ["unknown", "needs-human"].includes(outcome) ? outcome : "settled",
    outcome, reason: "Evidence recorded", summary: "Task result", writer_generation: 1,
    manual_required: ["unknown", "needs-human"].includes(outcome),
    mapping: {
      control_instance: d.control_instance, company_id: d.company_id, agent_id: d.agent_id,
      run_id: d.run_id, task_ref: d.task_ref, attempt_key: d.attempt_key,
      root_session_id: "session-1", root_turn_id: "turn-1", root_task_id: "hermes-task-1", session_edges: [],
      herdr_instance_ref: "herdr-1", server_generation: 1, workspace_id: "workspace-1", tab_id: "tab-1",
      pane_id: "pane-1", terminal_id: "terminal-1", scope_ref: "scope-1", host_boot_id: "boot-1",
      supervisor_generation: 1, process_start_identity: "pid-1:start-1",
    },
    completion: { status: "known", root_session_id: "session-1", root_turn_id: "turn-1", event_ids: ["root-end"] },
    stop_evidence: outcome === "unknown" ? null : {
      schema_version: 1, attempt_key: d.attempt_key, request_id: "request-1",
      reason: outcome === "cancelled" ? "cancel" : outcome === "timed_out" ? "deadline" : "reconcile",
      host_boot_id: "boot-1", scope_ref: "scope-1", supervisor_generation: 1, herdr_server_generation: 1,
      requested_at: "2026-01-01T00:00:00.000Z", checked_at: "2026-01-01T00:00:01.000Z",
      term_sent_at: null, kill_sent_at: null, scope_empty: true, remaining_processes: [], check_error: null, confirmed: true,
    },
    usage: { status: "unknown", value: null, reason: "No request coverage", buckets: null, lineage_coverage: "unknown", epoch: null },
    cost: { status: "unknown", value: null, reason: "No cost source", currency: null, source: null, pricing_version: null, kind: "unknown" },
    artifact_manifest: { revision: 1, sha256: sha256(canonical([])), entries: [] },
  });
}
function line(result: JsonObject): string { return canonical(result) + "\n"; }

describe("bridge protocol v1", () => {
  it("builds deterministic descriptors over exact UTF-8 prompt bytes and sorted params", () => {
    const d = descriptor();
    expect(d).toEqual(descriptor());
    expect(d.attempt_key).toBe(sha256('["control-1","company-1","run-1"]'));
    expect(d.prompt_size_bytes).toBe(Buffer.byteLength("請精確保留\r\nbytes\n"));
    expect(d.dispatch_sha256).toBe(contentHash(d, "dispatch_sha256"));
    expect(canonical({ b: [1, "台灣"], a: { z: 1, c: 2 } })).toBe('{"a":{"c":2,"z":1},"b":[1,"台灣"]}');
    expect(sha256("hello\r\n")).not.toBe(sha256("hello\n"));
  });
  it.each(["succeeded", "failed", "cancelled", "timed_out", "needs-human", "unknown"])("maps outcome %s without inventing accounting", (outcome) => {
    const d = descriptor();
    const result = mapBridgeResult(parseBridgeResult(line(envelope(d, outcome)), d, null));
    expect(result.exitCode).toBe(outcome === "succeeded" ? 0 : 1);
    expect(result.signal).toBe(outcome === "cancelled" ? "SIGTERM" : null);
    expect(result.timedOut).toBe(outcome === "timed_out");
    expect(result.errorCode).toBe(outcome === "succeeded" ? undefined : outcome === "needs-human" ? "bridge_needs_human" : `bridge_${outcome}`);
    expect(result).not.toHaveProperty("usage"); expect(result).not.toHaveProperty("costUsd");
    expect(result).not.toHaveProperty("executionRecovery");
    expect(result.resultJson?.execution).toMatchObject({ outcome });
  });
  it("maps complete request buckets once and omits partial and non-USD cost", () => {
    const d = descriptor(); const result = envelope(d);
    result.usage = { status: "known", value: 20, reason: null,
      buckets: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 3, reasoning_tokens: 4, request_count: 1 },
      lineage_coverage: "complete", epoch: "automatic-1" };
    result.cost = { status: "known", value: 1.25, reason: null, currency: "USD", source: "provider", pricing_version: null, kind: "actual" };
    expect(mapBridgeResult(parseBridgeResult(line(sign(result)), d, null))).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 2 }, usageBasis: "per_run", costUsd: 1.25,
    });
    result.usage.status = "partial"; result.usage.reason = "Missing child"; result.cost.currency = "EUR";
    const partial = mapBridgeResult(parseBridgeResult(line(sign(result)), d, null));
    expect(partial.usage).toBeUndefined(); expect(partial.costUsd).toBeUndefined();
    result.cost.status = "partial"; result.cost.currency = "USD"; result.cost.reason = "Estimate incomplete";
    expect(mapBridgeResult(parseBridgeResult(line(sign(result)), d, null)).costUsd).toBeUndefined();
  });
  it("preserves partially observed buckets without inventing missing token totals", () => {
    const d = descriptor(); const result = envelope(d);
    result.usage = { status: "partial", value: 10, reason: "Missing output usage", buckets: { input_tokens: 10 }, lineage_coverage: "partial", epoch: null };
    const mapped = mapBridgeResult(parseBridgeResult(line(sign(result)), d, null));
    expect(mapped.usage).toBeUndefined();
    expect(mapped.resultJson?.execution).toMatchObject({ usage: { buckets: { input_tokens: 10 } } });
  });
  it("accepts a bounded immutable manifest locator without embedding artifact content", () => {
    const d = descriptor(); const result = envelope(d);
    result.artifact_manifest = { revision: 1, entries: null, locator: `manifest:${d.attempt_key}`, sha256: "a".repeat(64), size_bytes: 2000000 };
    expect(parseBridgeResult(line(sign(result)), d, null).outcome).toBe("succeeded");
  });
  it("requires durable tombstone proof for never-started cancellation", () => {
    const d = descriptor(); const result = envelope(d, "cancelled");
    const stop = result.stop_evidence!;
    (result.mapping as JsonObject).scope_ref = null; stop.scope_ref = null;
    stop.never_started = true; stop.claim_consumed = false; stop.tombstone = true;
    expect(parseBridgeResult(line(sign(result)), d, null).outcome).toBe("cancelled");
    stop.tombstone = false;
    expect(() => parseBridgeResult(line(sign(result)), d, null)).toThrow("never-started");
  });
  it("accepts identical reports and the next revision, rejects gaps, stale and conflicting reports", () => {
    const d = descriptor(); const first = envelope(d);
    expect(parseBridgeResult(line(first), d, first)).toEqual(first);
    const second = envelope(d, "succeeded", 2, first.result_sha256);
    expect(parseBridgeResult(line(second), d, first)).toEqual(second);
    expect(() => parseBridgeResult(line(second), d, null)).toThrow();
    expect(() => parseBridgeResult(line(first), d, second)).toThrow();
    expect(() => parseBridgeResult(line(sign({ ...first, summary: "changed" })), d, first)).toThrow();
    expect(() => parseBridgeResult(line(envelope(d, "succeeded", 3, first.result_sha256)), d, first)).toThrow();
  });
  it.each([
    ["unknown version", (r: JsonObject) => { r.schema_version = 2; }],
    ["wrong run", (r: JsonObject) => { r.run_id = "other"; }],
    ["wrong dispatch", (r: JsonObject) => { r.dispatch_sha256 = "b".repeat(64); }],
    ["string revision", (r: JsonObject) => { r.result_revision = "1"; }],
    ["missing field", (r: JsonObject) => { delete r.mapping; }],
    ["manual flag", (r: JsonObject) => { r.manual_required = "false"; }],
    ["unconfirmed scope", (r: JsonObject) => { (r.stop_evidence as JsonObject).scope_empty = false; }],
    ["nonempty scope", (r: JsonObject) => { (r.stop_evidence as JsonObject).remaining_processes = [{ pid: 1, process_start_identity: "start-1" }]; }],
    ["generation mismatch", (r: JsonObject) => { (r.stop_evidence as JsonObject).supervisor_generation = 2; }],
    ["missing root event", (r: JsonObject) => { (r.completion as JsonObject).event_ids = []; }],
    ["wrong root", (r: JsonObject) => { (r.completion as JsonObject).root_session_id = "child"; }],
    ["no stop", (r: JsonObject) => { r.stop_evidence = null; }],
    ["running success", (r: JsonObject) => { r.state = "running"; }],
    ["unknown without manual", (r: JsonObject) => { r.outcome = "unknown"; r.state = "unknown"; r.manual_required = false; }],
    ["unknown filled zero", (r: JsonObject) => { (r.usage as JsonObject).value = 0; }],
    ["artifact hash mismatch", (r: JsonObject) => { (r.artifact_manifest as JsonObject).sha256 = "a".repeat(64); }],
  ])("rejects %s", (_name, mutate) => {
    const d = descriptor(); const r = envelope(d); (mutate as (r: JsonObject) => void)(r);
    expect(() => parseBridgeResult(line(sign(r)), d, null)).toThrow();
  });
  it("rejects a revision that rewrites settled outcome or stop facts", () => {
    const d = descriptor(); const first = envelope(d);
    const changed = envelope(d, "failed", 2, first.result_sha256);
    expect(() => parseBridgeResult(line(changed), d, first)).toThrow("immutable");
    changed.outcome = "succeeded"; (changed.stop_evidence as JsonObject).scope_ref = "other";
    expect(() => parseBridgeResult(line(sign(changed)), d, first)).toThrow("immutable");
  });
  it("validates evidence-only stop identity and generation", () => {
    const d = descriptor(); const evidence = envelope(d, "cancelled").stop_evidence!;
    expect(parseStopEvidence(line(evidence), d, "request-1", "cancel").confirmed).toBe(true);
    expect(() => parseStopEvidence(line(evidence), d, "other", "cancel")).toThrow("identity");
    expect(() => parseStopEvidence(line(evidence), d, "request-1", "cancel", { scope_ref: "replaced", host_boot_id: "boot-1", supervisor_generation: 1, server_generation: 1 })).toThrow("generation");
    evidence.scope_empty = false;
    expect(() => parseStopEvidence(line(evidence), d, "request-1", "cancel")).toThrow("stop");
  });
  it("rejects missing/truncated/noisy/oversize stdout and duplicate escaped keys", () => {
    const d = descriptor(); const good = line(envelope(d));
    for (const invalid of ["", "Session ID: native\n", good.trimEnd(), good + "noise\n", good + "\n", good.replace(/.$/s, ""),
      good.replace('"schema_version":1', '"schema_version":1,"schema_versio\\u006e":1'), " ".repeat(1024 * 1024) + good,
      good.replace('"writer_generation":1', '"writer_generation":1e999'), good.replace('"writer_generation":1', '"writer_generation":NaN')]) {
      expect(() => parseBridgeResult(invalid, d, null)).toThrow();
    }
    const r = envelope(d); r.summary = "tampered";
    expect(() => parseBridgeResult(line(r), d, null)).toThrow("hash");
    expect(() => strictJson('{"nested":{"x":1,"x":2}}')).toThrow("Duplicate");
  });
});

const run = vi.mocked(runAdapterExecutionTargetProcess);
let root: string;
let ctx: AdapterExecutionContext;
let signal: AbortController;
let sentDescriptor: DispatchDescriptor | undefined;
let sentPrompt: string | undefined;
const transportResult = (stdout = "") => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: null });
async function defaultTransport(...args: Parameters<typeof runAdapterExecutionTargetProcess>) {
  const [, , command, argv, options] = args;
  if (command === "/bin/sh") {
    if (argv[1].includes("descriptor.json")) sentDescriptor = JSON.parse(options.stdin!) as DispatchDescriptor;
    else sentPrompt = options.stdin;
    return transportResult();
  }
  const d = sentDescriptor ?? await savedDescriptor();
  if (argv[0] === "inspect") return transportResult(canonical({ protocol: BRIDGE_PROTOCOL, schema_version: 1,
    attempt_key: d.attempt_key, dispatch_sha256: d.dispatch_sha256, deadline: d.deadline, result_revision: 1 }));
  if (argv[0] === "stop") {
    const reason = argv[argv.indexOf("--reason") + 1];
    const result = envelope(d, reason === "cancel" ? "cancelled" : reason === "deadline" ? "timed_out" : "unknown");
    if (result.stop_evidence) {
      result.stop_evidence.reason = reason;
      result.stop_evidence.request_id = argv[argv.indexOf("--request") + 1];
    }
    return transportResult(line(sign(result)));
  }
  return transportResult(line(envelope(d)));
}
async function savedDescriptor(): Promise<DispatchDescriptor> {
  const dirs = await fs.readdir(root);
  const intent = JSON.parse(await fs.readFile(path.join(root, dirs[0], "intent.json"), "utf8"));
  return intent.descriptor as DispatchDescriptor;
}
function verbs(): string[] { return run.mock.calls.map((call) => call[3][0]); }

beforeEach(async () => {
  vi.useRealTimers(); run.mockReset(); run.mockImplementation(defaultTransport);
  root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hermes-bridge-"));
  signal = new AbortController(); sentDescriptor = undefined; sentPrompt = undefined;
  ctx = {
    runId: "run-1", agent: { id: "agent-1", name: "Hermes", companyId: "company-1", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: "task-1" },
    config: { hermesCommand: "/opt/aetherdesk/bridge", timeoutSec: 60,
      bridgeProfile: { controlInstance: "control-1", stateDirectory: root, workspacePolicySha256: "a".repeat(64), executionSlot: "slot-1", cleanupTimeoutSec: 1 } },
    context: { taskTitle: "Task", taskBody: "Exact prompt 世界\n" },
    executionTarget: { kind: "remote", transport: "ssh", remoteCwd: "/bridge", spec: {
      host: "execution.invalid", username: "bridge", port: 22, remoteCwd: "/bridge", remoteWorkspacePath: "/bridge",
      strictHostKeyChecking: true, knownHosts: "execution.invalid ssh-ed25519 fake-pinned-key", privateKey: "fake-control-private-key",
    } },
    signal: signal.signal, onCancellationReady: vi.fn(async () => {}), onEvent: vi.fn(async () => {}),
    onLog: vi.fn(async () => {}), onSpawn: vi.fn(async () => {}), onDispatch: vi.fn(),
  };
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

describe("explicit SSH bridge profile", () => {
  it.each(["missing", "local", "sandbox", "unknown", "insecure", "no-pin", "no-key", "bad-host", "bad-cwd"])("refuses target %s before connecting", async (kind) => {
    const target = ctx.executionTarget!;
    if (kind === "missing") ctx.executionTarget = null;
    else if (kind === "local") ctx.executionTarget = { kind: "local" };
    else if (kind === "sandbox") ctx.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: "/remote" } as never;
    else if (kind === "unknown") ctx.executionTarget = { kind: "remote", transport: "other" } as never;
    else {
      const spec = (target as unknown as { spec: JsonObject }).spec;
      if (kind === "insecure") spec.strictHostKeyChecking = false;
      if (kind === "no-pin") spec.knownHosts = null;
      if (kind === "no-key") spec.privateKey = null;
      if (kind === "bad-host") spec.host = "-oProxyCommand=bad";
      if (kind === "bad-cwd") spec.remoteCwd = "/other";
    }
    const result = await execute(ctx);
    expect(result.errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it("persists intent before readiness/connect, transfers only files and holds run stdin open", async () => {
    ctx.onCancellationReady = vi.fn(async () => { expect((await savedDescriptor()).attempt_key).toHaveLength(64); expect(run).not.toHaveBeenCalled(); });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0); expect(verbs()).toEqual(["-c", "-c", "run"]);
    expect(sentDescriptor!.prompt_sha256).toBe(sha256(sentPrompt!));
    expect(sentDescriptor!.prompt_size_bytes).toBe(Buffer.byteLength(sentPrompt!));
    const call = run.mock.calls[2];
    expect(call[3]).toEqual(["run", "--descriptor", `/bridge/.aetherdesk-${sentDescriptor!.attempt_key}/descriptor.json`]);
    expect(call[4]).toMatchObject({ env: {}, keepStdinOpen: true, isolateSsh: true });
    expect(call[4].onSpawn).toBe(ctx.onSpawn); expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(run.mock.calls.map((c) => c[3]))).not.toContain("Exact prompt");
    expect(ctx.onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "bridge.dispatch_intent" }));
  });
  it("keeps fake control/provider/runtime secrets out of actual built SSH argv", async () => {
    const canary = "fake-secret-canary-12345678";
    vi.stubEnv("PROVIDER_API_KEY", canary);
    ctx.config.env = { PAPERCLIP_API_KEY: canary, OPENAI_API_KEY: canary, PATH: canary, LANG: canary };
    ctx.authToken = canary;
    ctx.runtimeTools = { bearerToken: canary } as never;
    try {
      expect((await execute(ctx)).exitCode).toBe(0);
      expect(bridgeRemoteEnv(ctx.config.env as JsonObject)).toEqual({});
      for (const call of run.mock.calls) {
        expect(call[4].env).toEqual({});
        const built = await buildSshSpawnTarget({ spec: (ctx.executionTarget as AdapterSshExecutionTarget).spec,
          command: call[2], args: call[3], env: call[4].env, isolated: call[4].isolateSsh });
        try {
          expect(JSON.stringify(built.args)).not.toContain(canary);
          expect(built.args).toContain("ForwardAgent=no"); expect(built.args).toContain("/dev/null");
          expect(built.args).toContain("StrictHostKeyChecking=yes");
        } finally { await built.cleanup(); }
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["Bearer fake-secret-token", "sk-testsecrets1234567", "-----BEGIN PRIVATE KEY-----"])("rejects secret-looking prompt before connecting: %s", async (secret) => {
    ctx.context.taskBody = secret;
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalled();
  });
  it("rejects known opaque secrets in prompt and params before connecting", async () => {
    ctx.authToken = "opaque-control-credential"; ctx.config.model = ctx.authToken;
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it("rejects a known secret in command argv before connecting", async () => {
    ctx.authToken = "opaque-control-credential"; ctx.config.hermesCommand = `/opt/${ctx.authToken}/bridge`;
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it.each(["before-ready", "in-ready", "connect", "run"])("cancels at %s and waits for independent stop evidence", async (phase) => {
    let cleanupSignal: AbortSignal | undefined;
    if (phase === "before-ready") signal.abort();
    ctx.onCancellationReady = vi.fn(async () => { if (phase === "in-ready") signal.abort(); });
    run.mockImplementation(async (...args) => {
      if ((phase === "connect" && args[2] === "/bin/sh") || (phase === "run" && args[3][0] === "run")) {
        signal.abort(); throw new Error("cancelled mocked process");
      }
      if (args[3][0] === "stop") { cleanupSignal = args[4].signal; expect(cleanupSignal?.aborted).toBe(false); }
      return defaultTransport(...args);
    });
    const result = await execute(ctx);
    expect(ctx.onCancellationReady).toHaveBeenCalledOnce();
    expect(result.resultJson?.execution).toMatchObject({ outcome: "cancelled", stop_evidence: { confirmed: true } });
    expect(verbs().filter((v) => v === "stop")).toHaveLength(1);
    expect(cleanupSignal).not.toBe(signal.signal);
    if (["before-ready", "in-ready", "connect"].includes(phase)) expect(verbs()).not.toContain("run");
  });
  it("waits for cancellation readiness before even the stop connection", async () => {
    let releaseReady: (() => void) | undefined;
    let enteredReady: (() => void) | undefined;
    const registered = new Promise<void>((resolve) => { enteredReady = resolve; });
    ctx.onCancellationReady = () => new Promise<void>((resolve) => { releaseReady = resolve; enteredReady!(); });
    const result = execute(ctx);
    await registered; signal.abort(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled(); releaseReady!();
    expect((await result).signal).toBe("SIGTERM"); expect(verbs()).toEqual(["stop"]);
  });
  it("bounds independent cleanup when the mocked stop process hangs", async () => {
    signal.abort(); (ctx.config.bridgeProfile as JsonObject).cleanupTimeoutSec = 0.02;
    run.mockImplementation(async (...args) => new Promise((_resolve, reject) => {
      args[4].signal!.addEventListener("abort", () => reject(new Error("cleanup deadline")), { once: true });
    }));
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(verbs()).toEqual(["stop"]);
  });
  it("bounds a stalled run-event write without opening a connection", async () => {
    ctx.config.timeoutSec = 0.03; ctx.onEvent = () => new Promise<void>(() => {});
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it("accepts a never-started stop tombstone before the descriptor reaches the VM", async () => {
    signal.abort();
    run.mockImplementation(async (...args) => {
      const d = await savedDescriptor(); const argv = args[3];
      const evidence = envelope(d, "cancelled").stop_evidence!;
      evidence.request_id = argv[argv.indexOf("--request") + 1];
      evidence.scope_ref = null; evidence.never_started = true; evidence.claim_consumed = false; evidence.tombstone = true;
      return transportResult(line(evidence));
    });
    const result = await execute(ctx);
    expect(result.signal).toBe("SIGTERM"); expect(verbs()).toEqual(["stop"]);
    expect(result.resultJson?.execution).toMatchObject({ outcome: "cancelled", evidence_source: "bridge.stop", stop_confirmed: true });
    expect(result.resultJson?.execution).not.toHaveProperty("result_revision"); expect(result.usage).toBeUndefined();
  });
  it("rejects an evidence-only stop reply for another request", async () => {
    signal.abort();
    run.mockImplementation(async () => transportResult(line(envelope(await savedDescriptor(), "cancelled").stop_evidence!)));
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(verbs()).toEqual(["stop"]);
  });
  it("keeps cancellation unknown when stop cannot be confirmed", async () => {
    signal.abort(); run.mockRejectedValue(new Error("unreachable"));
    const result = await execute(ctx);
    expect(result.errorCode).toBe("bridge_unknown");
    expect(result.resultJson?.execution).toMatchObject({ stop_confirmed: false, outcome: "unknown" });
    expect(verbs()).toEqual(["stop"]);
  });
  it("uses one absolute deadline across readiness, sync, and run", async () => {
    const entry = Date.now(); const now = vi.spyOn(Date, "now").mockReturnValue(entry);
    ctx.onCancellationReady = vi.fn(async () => { now.mockReturnValue(entry + 20_000); });
    run.mockImplementation(async (...args) => {
      const result = await defaultTransport(...args);
      if (args[2] === "/bin/sh") now.mockReturnValue(entry + 30_000);
      return result;
    });
    try {
      expect((await execute(ctx)).exitCode).toBe(0);
      expect(sentDescriptor!.deadline).toBe(new Date(entry + 60_000).toISOString());
      expect(run.mock.calls[0][4].timeoutSec).toBe(40);
      expect(run.mock.calls[2][4].timeoutSec).toBe(30);
    } finally { now.mockRestore(); }
  });
  it("reaches unknown without connecting when cancellation readiness stalls", async () => {
    ctx.config.timeoutSec = 0.03;
    ctx.onCancellationReady = vi.fn(() => new Promise<void>(() => {}));
    const result = await execute(ctx);
    expect(result.errorCode).toBe("bridge_unknown"); expect(result.timedOut).toBe(false); expect(verbs()).toEqual([]);
  });
  it("inspects and reports on re-entry without resending prompt or extending deadline", async () => {
    expect((await execute(ctx)).exitCode).toBe(0);
    const first = sentDescriptor!;
    run.mockClear(); sentDescriptor = undefined; sentPrompt = undefined;
    ctx.context.taskBody = "Changed wake body must not be resent"; ctx.config.timeoutSec = 120;
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(verbs()).toEqual(["inspect", "report"]); expect(sentPrompt).toBeUndefined();
    expect((await savedDescriptor()).deadline).toBe(first.deadline);
    expect(run.mock.calls[0][4].timeoutSec).toBeLessThanOrEqual(60);
  });
  it("never re-runs after lost run output, even when no result was accepted", async () => {
    run.mockImplementation(async (...args) => {
      if (["run", "stop"].includes(args[3][0])) throw new Error("response lost");
      return defaultTransport(...args);
    });
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown");
    run.mockClear(); run.mockImplementation(defaultTransport); sentDescriptor = undefined;
    expect((await execute(ctx)).exitCode).toBe(0); expect(verbs()).toEqual(["inspect", "report"]);
  });
  it("stops on a full-run deadline during the mocked provider process", async () => {
    ctx.config.timeoutSec = 0.1;
    run.mockImplementation(async (...args) => {
      if (args[3][0] === "run") return new Promise((_resolve, reject) => {
        args[4].signal!.addEventListener("abort", () => reject(new Error("full deadline")), { once: true });
      });
      return defaultTransport(...args);
    });
    const result = await execute(ctx);
    expect(result.timedOut).toBe(true); expect(verbs()).toEqual(["-c", "-c", "run", "stop"]);
  });
  it("does not connect or rerun when a dispatch intent is corrupt", async () => {
    await execute(ctx); const dirs = await fs.readdir(root);
    await fs.writeFile(path.join(root, dirs[0], "intent.json"), "partial"); run.mockClear();
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it("does not dispatch when intent event persistence fails", async () => {
    ctx.onEvent = vi.fn(async () => { throw new Error("disk full"); });
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
    ctx.onEvent = vi.fn(async () => {});
    expect((await execute(ctx)).exitCode).toBe(0); expect(verbs()).toEqual(["inspect", "report"]);
  });
  it("never treats native text or exit zero as a bridge result", async () => {
    run.mockImplementation(async (...args) => args[2] === "/bin/sh" ? defaultTransport(...args) : transportResult("Success! Session ID: native\n"));
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown");
  });
  it("reports static bridge configuration without probing a local Hermes CLI", async () => {
    const result = await testEnvironment({ companyId: ctx.agent.companyId, adapterType: "hermes_local", config: ctx.config, executionTarget: ctx.executionTarget });
    expect(result.status).toBe("warn"); expect(result.checks[0].code).toBe("bridge_profile_preflight");
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves an already settled result when cancellation loses the DB race", async () => {
    signal.abort();
    run.mockImplementation(async (...args) => transportResult(line(envelope(await savedDescriptor()))));
    expect((await execute(ctx)).exitCode).toBe(0); expect(verbs()).toEqual(["stop"]);
  });
  it("retrieves intermediate immutable report revisions on re-entry", async () => {
    await execute(ctx); const d = sentDescriptor!; const first = envelope(d);
    const second = envelope(d, "succeeded", 2, first.result_sha256);
    const third = envelope(d, "succeeded", 3, second.result_sha256);
    run.mockClear();
    run.mockImplementation(async (...args) => {
      const argv = args[3];
      if (argv[0] === "inspect") return transportResult(canonical({ protocol: BRIDGE_PROTOCOL, schema_version: 1,
        attempt_key: d.attempt_key, dispatch_sha256: d.dispatch_sha256, deadline: d.deadline, result_revision: 3 }));
      return transportResult(line([first, second, third][Number(argv[4]) - 1]));
    });
    expect((await execute(ctx)).resultJson?.execution).toMatchObject({ result_revision: 3 });
    expect(verbs()).toEqual(["inspect", "report", "report", "report"]);
  });
  it("rejects target changes before reconnection", async () => {
    await execute(ctx); run.mockClear(); (ctx.executionTarget as AdapterSshExecutionTarget).spec.host = "other.invalid";
    expect((await execute(ctx)).errorCode).toBe("bridge_unknown"); expect(run).not.toHaveBeenCalled();
  });
  it("permits at most one run across concurrent invocations", async () => {
    const results = await Promise.all([execute(ctx), execute(ctx)]);
    expect(verbs().filter((verb) => verb === "run")).toHaveLength(1);
    expect(results.some((result) => result.exitCode === 0)).toBe(true);
  });
  it("fails closed when a remote target lacks explicit bridge configuration", async () => {
    delete ctx.config.bridgeProfile;
    await expect(execute(ctx)).rejects.toThrow("explicit bridgeProfile"); expect(run).not.toHaveBeenCalled();
  });
});
