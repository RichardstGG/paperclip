import { createHash } from "node:crypto";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export const BRIDGE_PROTOCOL = "aetherdesk.execution";
export const RESULT_LIMIT = 1024 * 1024;
export type JsonObject = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ["reserved", "starting", "running", "stopping", "needs-human", "manual", "unknown", "reconciling", "settled"];
const OUTCOMES = ["succeeded", "failed", "cancelled", "timed_out", "needs-human", "unknown"];

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as JsonObject;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Expected nonempty string");
  return value;
}
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Expected integer");
  return value as number;
}
function nullableText(value: unknown): void { if (value !== null) text(value); }
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("Expected SHA-256");
  return value;
}
function timestamp(value: unknown): void {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Expected UTC timestamp");
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = object(value);
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function contentHash(value: JsonObject, excluded: string): string {
  return sha256(canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== excluded))));
}

/** JSON.parse alone silently accepts duplicate keys, including escaped aliases. */
export function strictJson(source: string): unknown {
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] ?? "x")) offset++; };
  const string = (): string => {
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(source.slice(offset));
    check(match, "Invalid JSON string");
    offset += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const value = (depth: number): unknown => {
    check(depth <= 64, "JSON nesting limit");
    whitespace();
    if (source[offset] === '"') return string();
    const open = source[offset];
    if (open === "{" || open === "[") {
      offset++;
      const result: JsonObject | unknown[] = open === "{" ? Object.create(null) as JsonObject : [];
      const close = open === "{" ? "}" : "]";
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === close) { offset++; return result; }
      while (true) {
        whitespace();
        if (Array.isArray(result)) result.push(value(depth + 1));
        else {
          const key = string();
          check(!keys.has(key), "Duplicate JSON key");
          keys.add(key);
          whitespace();
          check(source[offset++] === ":", "Invalid JSON object");
          result[key] = value(depth + 1);
        }
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === close) return result;
        check(delimiter === ",", "Invalid JSON delimiter");
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset));
    check(literal, "Invalid JSON value");
    offset += literal[0].length;
    const parsed: unknown = JSON.parse(literal[0]);
    check(typeof parsed !== "number" || Number.isFinite(parsed), "Nonfinite JSON number");
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  check(offset === source.length, "Trailing JSON data");
  return parsed;
}

export interface DispatchDescriptor extends JsonObject {
  protocol: typeof BRIDGE_PROTOCOL;
  schema_version: 1;
  control_instance: string;
  company_id: string;
  agent_id: string;
  run_id: string;
  attempt_key: string;
  dispatch_sha256: string;
  deadline: string;
  prompt_sha256: string;
  prompt_size_bytes: number;
  prompt_file: string;
}
export function buildDescriptor(input: {
  controlInstance: string; companyId: string; agentId: string; runId: string;
  taskRef: string; prompt: string; deadline: string; remoteDirectory: string;
  params: JsonObject; workspacePolicySha256: string; executionSlot: string;
}): DispatchDescriptor {
  const tuple = [text(input.controlInstance), text(input.companyId), text(input.runId)];
  const attemptKey = sha256(canonical(tuple));
  timestamp(input.deadline);
  const descriptor = {
    protocol: BRIDGE_PROTOCOL as typeof BRIDGE_PROTOCOL, schema_version: 1 as const,
    control_instance: tuple[0], company_id: tuple[1], run_id: tuple[2],
    agent_id: text(input.agentId), task_ref: text(input.taskRef), tuple,
    attempt_key: attemptKey,
    prompt_sha256: sha256(input.prompt), prompt_size_bytes: Buffer.byteLength(input.prompt, "utf8"),
    prompt_file: `${input.remoteDirectory}/prompt.txt`,
    params: input.params, workspace_policy_sha256: hash(input.workspacePolicySha256),
    execution_slot: text(input.executionSlot), deadline: input.deadline,
  };
  return { ...descriptor, dispatch_sha256: sha256(canonical(descriptor)) };
}

export interface BridgeResult extends JsonObject {
  attempt_key: string;
  dispatch_sha256: string;
  run_id: string;
  result_revision: number;
  result_sha256: string;
  previous_result_sha256: string | null;
  state: string;
  outcome: string;
  reason: string;
  summary: string;
  manual_required: boolean;
  stop_evidence: JsonObject | null;
  usage: JsonObject;
  cost: JsonObject;
}

function validateStop(stop: JsonObject, mapping: JsonObject, attemptKey: string): void {
  check(stop.schema_version === 1 && stop.attempt_key === attemptKey, "Stop identity mismatch");
  text(stop.request_id);
  check(["cancel", "deadline", "channel_lost", "takeover", "reconcile"].includes(text(stop.reason)), "Invalid stop reason");
  timestamp(stop.requested_at); timestamp(stop.checked_at);
  for (const key of ["term_sent_at", "kill_sent_at"]) if (stop[key] !== null) timestamp(stop[key]);
  check(typeof stop.confirmed === "boolean", "Invalid stop confirmation");
  check(stop.scope_empty === null || typeof stop.scope_empty === "boolean", "Invalid scope evidence");
  check(Array.isArray(stop.remaining_processes), "Invalid process evidence");
  for (const process of stop.remaining_processes) {
    const item = object(process); integer(item.pid, 1); text(item.process_start_identity);
  }
  nullableText(stop.check_error);
  for (const key of ["host_boot_id", "scope_ref"]) nullableText(stop[key]);
  for (const key of ["supervisor_generation", "herdr_server_generation"]) if (stop[key] !== null) integer(stop[key]);
  if (!stop.confirmed) return;
  check(stop.scope_empty === true && stop.remaining_processes.length === 0 && stop.check_error === null, "Unproven stop");
  if (stop.never_started === true) {
    check(stop.claim_consumed === false && stop.tombstone === true && stop.scope_ref === null && mapping.scope_ref === null,
      "Unproven never-started stop");
  } else {
    text(stop.host_boot_id); text(stop.scope_ref);
    integer(stop.supervisor_generation, 1); integer(stop.herdr_server_generation, 1);
    check(stop.host_boot_id === mapping.host_boot_id && stop.scope_ref === mapping.scope_ref &&
      stop.supervisor_generation === mapping.supervisor_generation && stop.herdr_server_generation === mapping.server_generation,
    "Stop generation mismatch");
  }
}
/** Stop may precede descriptor delivery, so it has its own evidence-only reply. */
export function parseStopEvidence(stdout: string, descriptor: DispatchDescriptor, requestId: string, reason: string,
  mapping?: JsonObject): JsonObject {
  check(Buffer.byteLength(stdout, "utf8") <= RESULT_LIMIT && stdout.endsWith("\n") &&
    !stdout.slice(0, -1).includes("\n") && !stdout.includes("\r"), "Expected one stop evidence line");
  const evidence = object(strictJson(stdout));
  check(evidence.attempt_key === descriptor.attempt_key && evidence.request_id === requestId && evidence.reason === reason,
    "Stop request identity mismatch");
  validateStop(evidence, mapping ?? {
    host_boot_id: evidence.host_boot_id, scope_ref: evidence.scope_ref,
    supervisor_generation: evidence.supervisor_generation, server_generation: evidence.herdr_server_generation,
  }, descriptor.attempt_key);
  check(evidence.confirmed === true, "Stop is unconfirmed");
  return evidence;
}

function validateTotal(total: JsonObject): void {
  check(["known", "partial", "unknown"].includes(text(total.status)), "Invalid coverage");
  check(total.value === null || (typeof total.value === "number" && Number.isFinite(total.value) && total.value >= 0), "Invalid total");
  nullableText(total.reason);
  if (total.status === "known") check(total.value !== null, "Missing known total");
  else text(total.reason);
  if (total.status === "unknown") check(total.value === null, "Unknown total must be null");
}

/** Validates one immutable revision against the locally accepted chain. */
export function parseBridgeResult(stdout: string, descriptor: DispatchDescriptor, previous: BridgeResult | null): BridgeResult {
  check(Buffer.byteLength(stdout, "utf8") <= RESULT_LIMIT, "Result exceeds 1 MiB");
  check(stdout.endsWith("\n") && stdout.slice(0, -1).indexOf("\n") === -1 && !stdout.includes("\r") && !stdout.includes("\ufffd"), "Expected one UTF-8 JSON line and LF");
  const result = object(strictJson(stdout));
  check(result.protocol === BRIDGE_PROTOCOL && result.schema_version === 1, "Unsupported bridge protocol");
  check(result.attempt_key === descriptor.attempt_key && result.dispatch_sha256 === descriptor.dispatch_sha256 && result.run_id === descriptor.run_id, "Result dispatch mismatch");
  integer(result.result_revision, 1); hash(result.result_sha256);
  check(result.result_sha256 === contentHash(result, "result_sha256"), "Result hash mismatch");
  if (previous && result.result_revision === previous.result_revision) {
    check(result.result_sha256 === previous.result_sha256, "Conflicting result revision");
  } else {
    check(result.result_revision === (previous?.result_revision ?? 0) + 1 &&
      result.previous_result_sha256 === (previous?.result_sha256 ?? null), "Broken result chain");
  }
  if (result.previous_result_sha256 !== null) hash(result.previous_result_sha256);
  if (previous?.state === "settled") {
    check(result.state === "settled" && result.outcome === previous.outcome, "Settled outcome is immutable");
    for (const key of ["completion", "stop_evidence", "mapping", "writer_generation"]) {
      check(canonical(result[key]) === canonical(previous[key]), "Settled execution evidence is immutable");
    }
  }
  check(STATES.includes(text(result.state)) && OUTCOMES.includes(text(result.outcome)), "Invalid lifecycle");
  text(result.reason); integer(result.writer_generation);
  check(typeof result.manual_required === "boolean", "Invalid manual flag");
  check(typeof result.summary === "string" && result.summary.length <= 16000, "Invalid summary");
  const mapping = object(result.mapping);
  for (const key of ["control_instance", "company_id", "agent_id", "run_id", "task_ref", "attempt_key"]) {
    check(mapping[key] === descriptor[key], "Mapping dispatch mismatch");
  }
  for (const key of ["root_session_id", "root_turn_id", "root_task_id", "herdr_instance_ref", "workspace_id", "tab_id", "pane_id", "terminal_id", "scope_ref", "host_boot_id", "process_start_identity"]) nullableText(mapping[key]);
  for (const key of ["server_generation", "supervisor_generation"]) if (mapping[key] !== null) integer(mapping[key], 1);
  check(Array.isArray(mapping.session_edges), "Invalid lineage mapping");
  for (const edge of mapping.session_edges) {
    const item = object(edge); text(item.parent_session_id); text(item.child_session_id);
  }
  const completion = object(result.completion);
  check(["known", "unknown"].includes(text(completion.status)), "Invalid completion");
  nullableText(completion.root_session_id); nullableText(completion.root_turn_id);
  check(Array.isArray(completion.event_ids) && completion.event_ids.every((id) => typeof id === "string" && id.length > 0), "Invalid completion events");
  if (result.stop_evidence !== null) validateStop(object(result.stop_evidence), mapping, descriptor.attempt_key);
  const stopped = result.stop_evidence !== null && object(result.stop_evidence).confirmed === true;
  if (result.stop_confirmed !== undefined) check(result.stop_confirmed === stopped, "Contradictory stop confirmation");
  if (result.state === "settled") {
    check(["succeeded", "failed", "cancelled", "timed_out"].includes(result.outcome as string) && stopped, "Unsettled outcome");
  } else {
    check(["unknown", "needs-human"].includes(result.outcome as string) && result.manual_required === true, "Unsafe nonterminal outcome");
    if (result.state === "unknown") check(result.outcome === "unknown", "Unknown state outcome mismatch");
    if (result.state === "needs-human") check(result.outcome === "needs-human", "Human state outcome mismatch");
    if (result.outcome === "needs-human") check(stopped, "Human handoff without stop");
  }
  const manifest = object(result.artifact_manifest);
  integer(manifest.revision, 1); hash(manifest.sha256);
  if (manifest.entries === null || manifest.entries === undefined) {
    text(manifest.locator); integer(manifest.size_bytes, 1);
  } else {
    check(Array.isArray(manifest.entries), "Invalid artifact manifest");
    const paths = new Set<string>();
    for (const value of manifest.entries) {
      const entry = object(value); const entryPath = text(entry.path);
      check(!entryPath.startsWith("/") && !entryPath.includes("\\") && !entryPath.split("/").some((part) => ["", ".", ".."].includes(part)) && !paths.has(entryPath), "Unsafe artifact path");
      paths.add(entryPath); hash(entry.sha256); integer(entry.size_bytes); integer(entry.writer_generation);
      check(entry.producing_attempt_key === descriptor.attempt_key, "Artifact attempt mismatch");
    }
    check(manifest.sha256 === sha256(canonical(manifest.entries)), "Manifest hash mismatch");
  }
  if (result.outcome === "succeeded") {
    check(result.state === "settled" && completion.status === "known" && completion.event_ids.length > 0 &&
      completion.root_session_id === mapping.root_session_id && completion.root_turn_id === mapping.root_turn_id,
    "Missing root completion");
    text(completion.root_session_id); text(completion.root_turn_id);
  }
  if (["cancelled", "timed_out"].includes(result.outcome as string)) {
    check(object(result.stop_evidence).reason === (result.outcome === "cancelled" ? "cancel" : "deadline"), "Stop reason mismatch");
  }
  const usage = object(result.usage); const cost = object(result.cost);
  validateTotal(usage); validateTotal(cost);
  check(["complete", "partial", "unknown"].includes(text(usage.lineage_coverage)), "Invalid lineage coverage");
  nullableText(usage.epoch);
  if (usage.value !== null) integer(usage.value);
  if (usage.buckets !== null) {
    const buckets = object(usage.buckets);
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "request_count"]) {
      if (usage.status === "known" || (buckets[key] !== undefined && buckets[key] !== null)) integer(buckets[key]);
    }
    if (usage.status === "known") {
      check(usage.lineage_coverage === "complete", "Incomplete known usage"); text(usage.epoch);
      check(usage.value === (buckets.input_tokens as number) + (buckets.cache_read_tokens as number) + (buckets.cache_write_tokens as number) + (buckets.output_tokens as number), "Usage total mismatch");
    }
  } else check(usage.status !== "known", "Missing usage buckets");
  for (const key of ["currency", "source", "pricing_version"]) nullableText(cost[key]);
  check(["actual", "estimated", "unknown"].includes(text(cost.kind)), "Invalid cost provenance");
  if (cost.status === "known") { text(cost.currency); text(cost.source); check(cost.kind !== "unknown", "Unproven known cost"); }
  if (result.question !== undefined && result.question !== null) {
    const question = object(result.question); text(question.prompt);
    check(Array.isArray(question.choices), "Invalid question choices");
    for (const choice of question.choices) { const item = object(choice); text(item.key); text(item.label); if (item.description !== undefined) text(item.description); }
  }
  return result as BridgeResult;
}

export function mapBridgeResult(result: BridgeResult): AdapterExecutionResult {
  const succeeded = result.outcome === "succeeded";
  const mapped: AdapterExecutionResult = {
    exitCode: succeeded ? 0 : 1,
    signal: result.outcome === "cancelled" ? "SIGTERM" : null,
    timedOut: result.outcome === "timed_out",
    resultJson: { execution: result, stop_confirmed: result.stop_evidence?.confirmed === true }, summary: result.summary,
  };
  if (!succeeded) {
    mapped.errorCode = result.outcome === "needs-human" ? "bridge_needs_human" : `bridge_${result.outcome}`;
    mapped.errorMessage = result.reason;
  }
  if (result.question) mapped.question = result.question as AdapterExecutionResult["question"];
  if (result.usage.status === "known") {
    const buckets = object(result.usage.buckets);
    mapped.usage = {
      inputTokens: (buckets.input_tokens as number) + (buckets.cache_read_tokens as number) + (buckets.cache_write_tokens as number),
      outputTokens: buckets.output_tokens as number, cachedInputTokens: buckets.cache_read_tokens as number,
    };
    mapped.usageBasis = "per_run";
  }
  if (result.cost.status === "known" && result.cost.currency === "USD") mapped.costUsd = result.cost.value as number;
  return mapped;
}
