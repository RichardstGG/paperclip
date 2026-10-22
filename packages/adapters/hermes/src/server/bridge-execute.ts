import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  readAdapterExecutionTarget, runAdapterExecutionTargetProcess,
  type AdapterSshExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { renderTemplate, selectPaperclipTaskMarkdown } from "@paperclipai/adapter-utils/server-utils";
import {
  BRIDGE_PROTOCOL, RESULT_LIMIT, buildDescriptor, canonical, contentHash, mapBridgeResult,
  object, parseBridgeResult, parseStopEvidence, sha256, strictJson, text,
  type BridgeResult, type DispatchDescriptor, type JsonObject,
} from "./bridge-protocol.js";

// Intentionally empty. Adding a key requires a credential-boundary review.
const REMOTE_ENV_KEYS: ReadonlySet<string> = new Set();
export function bridgeRemoteEnv(candidate: JsonObject): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!REMOTE_ENV_KEYS.has(key)) continue;
    if (typeof value !== "string" || /key|token|secret|password|credential|bearer/i.test(key)) {
      throw new Error("Bridge remote environment rejected");
    }
    assertNonSecret(value, []);
    env[key] = value;
  }
  return env;
}
function assertNonSecret(value: string, knownSecrets: string[]): void {
  if (/-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(value) ||
    knownSecrets.some((secret) => secret.length > 0 && value.includes(secret))) {
    throw new Error("Bridge payload contains a secret-like value");
  }
}
function positiveNumber(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0 || result > maximum) {
    throw new Error("Bridge timeout must be positive and bounded");
  }
  return result;
}
function absolutePath(value: unknown): string {
  const result = text(value);
  if (!path.posix.isAbsolute(result) || path.posix.normalize(result) !== result || /[\r\n]/.test(result)) {
    throw new Error("Bridge requires normalized absolute paths");
  }
  return result;
}
export function bridgeTarget(ctx: Pick<AdapterExecutionContext, "executionTarget">): AdapterSshExecutionTarget {
  // Never fall back to a legacy target or a local process for this profile.
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });
  if (!target || target.kind !== "remote" || target.transport !== "ssh") throw new Error("Bridge profile requires an SSH execution target");
  const spec = target.spec;
  if (spec.strictHostKeyChecking !== true || !spec.knownHosts?.trim() || !spec.privateKey?.trim()) {
    throw new Error("Bridge profile requires a pinned host key, strict checking and an explicit SSH identity");
  }
  if (!/^[a-zA-Z0-9_.:-]+$/.test(spec.host) || spec.host.startsWith("-") ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(spec.username) ||
    !Number.isSafeInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw new Error("Invalid bridge SSH target");
  absolutePath(target.remoteCwd);
  if (spec.remoteCwd !== target.remoteCwd) throw new Error("Bridge SSH working directory mismatch");
  return target;
}
function targetFingerprint(target: AdapterSshExecutionTarget, command: string): string {
  return sha256(canonical({
    command, host: target.spec.host, port: target.spec.port, username: target.spec.username,
    remoteCwd: target.remoteCwd, knownHostsSha256: sha256(target.spec.knownHosts!),
  }));
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) || await fs.realpath(directory) !== directory) {
    throw new Error("Bridge control state must be an owned, private, nonsymlink directory");
  }
}
async function readRecord(filename: string): Promise<JsonObject> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > RESULT_LIMIT) throw new Error("Invalid bridge control record");
  return object(strictJson(await fs.readFile(filename, "utf8")));
}
/** Exclusive creation consumes dispatch permission even if the process crashes mid-write. */
async function persist(filename: string, record: JsonObject): Promise<boolean> {
  const serialized = canonical(record);
  if (Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT) throw new Error("Bridge control record exceeds limit");
  let handle;
  try { handle = await fs.open(filename, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try { await handle.writeFile(serialized); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
  return true;
}
function unknownResult(reason: string, descriptor?: DispatchDescriptor): AdapterExecutionResult {
  return {
    exitCode: 1, signal: null, timedOut: false, errorCode: "bridge_unknown", errorMessage: reason,
    resultJson: { execution: {
      protocol: BRIDGE_PROTOCOL, schema_version: 1, attempt_key: descriptor?.attempt_key ?? null,
      dispatch_sha256: descriptor?.dispatch_sha256 ?? null, run_id: descriptor?.run_id ?? null,
      state: "unknown", outcome: "unknown", reason, manual_required: true, stop_confirmed: false,
      stop_evidence: null, usage: { status: "unknown", value: null, reason },
      cost: { status: "unknown", value: null, reason },
    } },
  };
}
function bridgePrompt(ctx: AdapterExecutionContext): string {
  const taskMarkdown = selectPaperclipTaskMarkdown(ctx.context);
  const vars = {
    agent: { id: ctx.agent.id, name: ctx.agent.name, companyId: ctx.agent.companyId },
    run: { id: ctx.runId }, taskId: ctx.runtime.taskKey,
    taskTitle: typeof ctx.context.taskTitle === "string" ? ctx.context.taskTitle : "",
    taskBody: typeof ctx.context.taskBody === "string" ? ctx.context.taskBody : "",
    taskMarkdown,
  };
  // No native Paperclip API instructions, runtime bearer, raw wake payload or environment.
  const template = typeof ctx.config.promptTemplate === "string" ? ctx.config.promptTemplate :
    "{{taskTitle}}\n\n{{taskBody}}\n\n{{taskMarkdown}}";
  return renderTemplate(template, vars);
}

export async function executeBridge(ctx: AdapterExecutionContext, enteredAt: number): Promise<AdapterExecutionResult> {
  const operation = new AbortController();
  let stopReason: "cancel" | "deadline" | "channel_lost" | null = null;
  const abort = () => { stopReason ??= "cancel"; operation.abort(); };
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let descriptor: DispatchDescriptor | undefined;
  let directory: string | undefined;
  let target: AdapterSshExecutionTarget | undefined;
  let command = "";
  let cleanupSec = 10;
  let previous: BridgeResult | null = null;
  let seq = 0;
  let connected = false;
  let cancellationReady = false;
  let intentPersisted = false;
  let stopAttempted = false;
  let cleanupDeadline = 0;
  let cleanupSignal: AbortSignal | undefined;

  const beforeDeadline = async (work: Promise<unknown> | undefined): Promise<void> => {
    const signal = AbortSignal.timeout(Math.max(1, Date.parse(descriptor!.deadline) - Date.now()));
    let onDeadline: (() => void) | undefined;
    try {
      await Promise.race([work, new Promise<never>((_resolve, reject) => {
        onDeadline = () => reject(new Error("Bridge setup deadline exceeded"));
        signal.addEventListener("abort", onDeadline, { once: true });
      })]);
    } finally {
      if (onDeadline) signal.removeEventListener("abort", onDeadline);
    }
  };

  const invoke = async (args: string[], options: { command?: string; stdin?: string; keepStdinOpen?: boolean; cleanup?: boolean } = {}) => {
    const signal = options.cleanup ? cleanupSignal! : operation.signal;
    signal.throwIfAborted();
    const remaining = ((options.cleanup ? cleanupDeadline : Date.parse(descriptor!.deadline)) - Date.now()) / 1000;
    if (remaining <= 0) { stopReason ??= "deadline"; operation.abort(); throw new Error("Bridge deadline exceeded"); }
    connected = true;
    let stdoutBytes = 0;
    const result = await runAdapterExecutionTargetProcess(
      `${ctx.runId}:bridge:${++seq}`, target!, options.command ?? command, args, {
        cwd: "/", env: bridgeRemoteEnv({}), stdin: options.stdin,
        keepStdinOpen: options.keepStdinOpen, signal, isolateSsh: true,
        timeoutSec: remaining, graceSec: 1,
        // Protocol output is validated before it is published. Never log untrusted diagnostics.
        onLog: async (stream, chunk) => {
          if (stream === "stdout") stdoutBytes += Buffer.byteLength(chunk, "utf8");
        },
        onSpawn: options.cleanup ? undefined : ctx.onSpawn,
      },
    );
    if (stdoutBytes > RESULT_LIMIT || Buffer.byteLength(result.stdout, "utf8") > RESULT_LIMIT) throw new Error("Bridge output exceeds limit");
    if (result.exitCode !== 0 || result.signal || result.timedOut) throw new Error("Bridge transport failed");
    return result.stdout;
  };
  const accept = async (stdout: string): Promise<BridgeResult> => {
    const result = parseBridgeResult(stdout, descriptor!, previous);
    if (result.outcome === "cancelled") {
      const request = await readRecord(path.join(directory!, "stop-cancel.json"));
      if (request.request_id !== object(result.stop_evidence).request_id) throw new Error("Unrequested cancellation result");
    }
    if (result.outcome === "timed_out" && Date.now() < Date.parse(descriptor!.deadline)) throw new Error("Premature deadline result");
    const filename = path.join(directory!, `result-${result.result_revision}.json`);
    if (!await persist(filename, result)) {
      if (canonical(await readRecord(filename)) !== canonical(result)) throw new Error("Conflicting accepted revision");
    }
    previous = result;
    return result;
  };
  const stop = async (): Promise<AdapterExecutionResult> => {
    if (stopAttempted) throw new Error("Bridge cleanup already attempted");
    stopAttempted = true;
    cleanupDeadline = Date.now() + cleanupSec * 1000;
    cleanupSignal = AbortSignal.timeout(Math.ceil(cleanupSec * 1000));
    const reason = stopReason ?? "channel_lost";
    const requestId = sha256(canonical([descriptor!.attempt_key, reason]));
    await persist(path.join(directory!, `stop-${reason}.json`), { request_id: requestId, reason });
    const stdout = await invoke(["stop", "--attempt", descriptor!.attempt_key, "--reason", reason, "--request", requestId], { cleanup: true });
    const header = object(strictJson(stdout));
    if (header.protocol === undefined) {
      // Before descriptor delivery the bridge can attest only the tombstone/scope.
      const evidence = parseStopEvidence(stdout, descriptor!, requestId, reason,
        previous?.mapping ? object(previous.mapping) : undefined);
      const evidencePath = path.join(directory!, `stop-evidence-${reason}.json`);
      if (!await persist(evidencePath, evidence) && canonical(await readRecord(evidencePath)) !== canonical(evidence)) {
        throw new Error("Conflicting stop evidence");
      }
      if (previous?.state === "settled") return mapBridgeResult(previous);
      const outcome = reason === "cancel" ? "cancelled" : reason === "deadline" ? "timed_out" : "unknown";
      const result = unknownResult("Bridge stopped; completion/accounting require report reconciliation", descriptor);
      result.errorCode = `bridge_${outcome}`;
      result.signal = outcome === "cancelled" ? "SIGTERM" : null;
      result.timedOut = outcome === "timed_out";
      result.resultJson = { execution: {
        ...object(result.resultJson!.execution), evidence_source: "bridge.stop",
        state: outcome === "unknown" ? "unknown" : "settled", outcome, manual_required: outcome === "unknown",
        stop_confirmed: true, stop_evidence: evidence,
      }, stop_confirmed: true };
      return result;
    }
    // Once a descriptor is known, stop may return the immutable result v1 instead.
    const latest = header.result_revision;
    if (!Number.isSafeInteger(latest) || (latest as number) < 1 || (latest as number) - (previous?.result_revision ?? 0) > 1000) {
      throw new Error("Invalid stop result revision");
    }
    for (let revision = (previous?.result_revision ?? 0) + 1; revision < (latest as number); revision++) {
      await accept(await invoke(["report", "--attempt", descriptor!.attempt_key, "--revision", String(revision)], { cleanup: true }));
    }
    const result = await accept(stdout);
    const evidence = result.stop_evidence;
    if (!evidence || evidence.confirmed !== true) throw new Error("Bridge stop is unconfirmed");
    // A result committed before this stop request wins the cancellation/completion race.
    if (!["succeeded", "failed"].includes(result.outcome) && (evidence.request_id !== requestId || evidence.reason !== reason)) {
      throw new Error("Bridge stop request mismatch");
    }
    return mapBridgeResult(result);
  };
  try {
    const profile = object(ctx.config.bridgeProfile);
    const timeoutSec = positiveNumber(ctx.config.timeoutSec, 300, 2147483);
    cleanupSec = positiveNumber(profile.cleanupTimeoutSec, 10, 60);
    const initialDeadline = new Date(enteredAt + timeoutSec * 1000).toISOString();
    deadlineTimer = setTimeout(() => { stopReason ??= "deadline"; operation.abort(); }, Math.max(0, Date.parse(initialDeadline) - Date.now()));
    target = bridgeTarget(ctx);
    command = absolutePath(ctx.config.hermesCommand);
    const controlInstance = text(profile.controlInstance);
    const stateDirectory = absolutePath(profile.stateDirectory);
    await privateDirectory(stateDirectory);
    const attemptKey = sha256(canonical([controlInstance, text(ctx.agent.companyId), text(ctx.runId)]));
    directory = path.join(stateDirectory, attemptKey);
    try { await fs.mkdir(directory, { mode: 0o700 }); await syncDirectory(stateDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await privateDirectory(directory);
    const remoteDirectory = path.posix.join(target.remoteCwd, `.aetherdesk-${attemptKey}`);
    const intentPath = path.join(directory, "intent.json");
    let existing: JsonObject | null = null;
    try { existing = await readRecord(intentPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let prompt = "";
    const fingerprint = targetFingerprint(target, command);
    let fresh = false;
    if (existing) {
      descriptor = object(existing.descriptor) as DispatchDescriptor;
      if (descriptor.protocol !== BRIDGE_PROTOCOL || descriptor.schema_version !== 1 ||
        descriptor.attempt_key !== attemptKey || descriptor.run_id !== ctx.runId || descriptor.agent_id !== ctx.agent.id ||
        descriptor.control_instance !== controlInstance || descriptor.company_id !== ctx.agent.companyId ||
        !Number.isFinite(Date.parse(descriptor.deadline)) || !/^[a-f0-9]{64}$/.test(descriptor.prompt_sha256) ||
        !Number.isSafeInteger(descriptor.prompt_size_bytes) || descriptor.prompt_size_bytes < 0 ||
        descriptor.prompt_file !== `${remoteDirectory}/prompt.txt` ||
        descriptor.dispatch_sha256 !== contentHash(descriptor, "dispatch_sha256") || existing.target_sha256 !== fingerprint) {
        throw new Error("Bridge dispatch intent mismatch");
      }
    } else {
      prompt = bridgePrompt(ctx);
      const params: JsonObject = {};
      for (const key of ["model", "provider", "toolsets"]) {
        if (ctx.config[key] !== undefined) params[key] = text(ctx.config[key]);
      }
      if (ctx.config.maxTurnsPerRun !== undefined) {
        const turns = ctx.config.maxTurnsPerRun;
        if (!Number.isSafeInteger(turns) || (turns as number) <= 0) throw new Error("Invalid bridge max turns");
        params.maxTurnsPerRun = turns;
      }
      descriptor = buildDescriptor({
        controlInstance, companyId: ctx.agent.companyId, agentId: ctx.agent.id, runId: ctx.runId,
        taskRef: text(ctx.runtime.taskKey), prompt, deadline: initialDeadline, remoteDirectory, params,
        workspacePolicySha256: text(profile.workspacePolicySha256), executionSlot: text(profile.executionSlot),
      });
      const knownSecrets = [ctx.authToken, target.spec.privateKey, ctx.runtimeTools?.bearerToken,
        ...(ctx.runtimeMcp?.getServers().map((server) => server.token) ?? []),
        ...Object.entries(process.env).filter(([key]) => /key|token|secret|password|credential/i.test(key)).map(([, value]) => value),
        ...Object.entries(ctx.config.env && typeof ctx.config.env === "object" ? ctx.config.env : {})
          .filter(([key]) => /key|token|secret|password|credential/i.test(key)).map(([, value]) => value),
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      assertNonSecret(prompt, knownSecrets);
      assertNonSecret(canonical(descriptor), knownSecrets);
      assertNonSecret(canonical({ command, host: target.spec.host, username: target.spec.username }), knownSecrets);
      fresh = await persist(intentPath, { descriptor, target_sha256: fingerprint });
      if (!fresh) {
        const winner = await readRecord(intentPath);
        if (canonical(winner.descriptor) !== canonical(descriptor) || winner.target_sha256 !== fingerprint) throw new Error("Concurrent bridge dispatch conflict");
      }
    }
    intentPersisted = true;
    // Local intent is authoritative across re-entry; the durable run event is an additional index.
    if (fresh) await beforeDeadline(ctx.onEvent?.({ eventType: "bridge.dispatch_intent", payload: { descriptor } }));
    const accepted = (await fs.readdir(directory)).filter((name) => /^result-[1-9][0-9]*\.json$/.test(name))
      .sort((a, b) => Number(a.slice(7, -5)) - Number(b.slice(7, -5)));
    for (const filename of accepted) previous = parseBridgeResult(canonical(await readRecord(path.join(directory, filename))) + "\n", descriptor, previous);
    // Restore the immutable deadline before any readiness/connection work.
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => { stopReason ??= "deadline"; operation.abort(); }, Math.max(0, Date.parse(descriptor.deadline) - Date.now()));
    if (Date.now() >= Date.parse(descriptor.deadline)) { stopReason ??= "deadline"; operation.abort(); }
    // Do not connect, including stop, until cancellation registration completes.
    // A stalled registration reaches unknown at the deadline without opening SSH.
    await beforeDeadline(ctx.onCancellationReady?.());
    cancellationReady = true;
    if (ctx.signal?.aborted) abort();
    if (operation.signal.aborted) return await stop();
    if (!fresh) {
      // Inspect is a read-only protocol snapshot; advance the hash chain one revision at a time.
      const snapshot = object(strictJson(await invoke(["inspect", "--attempt", attemptKey])));
      if (snapshot.protocol !== BRIDGE_PROTOCOL || snapshot.schema_version !== 1 || snapshot.attempt_key !== attemptKey ||
        snapshot.dispatch_sha256 !== descriptor.dispatch_sha256 || snapshot.deadline !== descriptor.deadline ||
        !Number.isSafeInteger(snapshot.result_revision) || (snapshot.result_revision as number) < 1 ||
        (snapshot.result_revision as number) < (previous?.result_revision ?? 0)) throw new Error("Invalid bridge inspection");
      const latest = snapshot.result_revision as number;
      // A bounded loop avoids an untrusted snapshot requesting unbounded remote work.
      if (latest - (previous?.result_revision ?? 0) > 1000) throw new Error("Bridge report chain too long");
      let result = previous;
      for (let revision = previous?.result_revision ?? 1; revision <= latest; revision++) {
        result = await accept(await invoke(["report", "--attempt", attemptKey, "--revision", String(revision)]));
      }
      return mapBridgeResult(result!);
    }
    operation.signal.throwIfAborted();
    // Only these two files are transferred. No control workspace, runtime assets or credentials.
    const stage = 'umask 077; mkdir -m 700 -- "$1" && cat > "$1/prompt.txt"';
    await invoke(["-c", stage, "bridge-stage", remoteDirectory], { command: "/bin/sh", stdin: prompt });
    await invoke(["-c", 'umask 077; cat > "$1/descriptor.json"', "bridge-stage", remoteDirectory], {
      command: "/bin/sh", stdin: canonical(descriptor) + "\n",
    });
    operation.signal.throwIfAborted();
    ctx.onDispatch?.();
    const stdout = await invoke(["run", "--descriptor", `${remoteDirectory}/descriptor.json`], { keepStdinOpen: true });
    if (operation.signal.aborted) return await stop();
    return mapBridgeResult(await accept(stdout));
  } catch {
    // Neither transport errors nor native Hermes text can turn missing evidence into success.
    if (cancellationReady && intentPersisted && descriptor && directory && target && (connected || operation.signal.aborted)) {
      try { return await stop(); } catch { /* Preserve unknown; never claim a safe stop. */ }
    }
    return unknownResult("Bridge execution requires reconciliation", descriptor);
  } finally {
    clearTimeout(deadlineTimer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}
