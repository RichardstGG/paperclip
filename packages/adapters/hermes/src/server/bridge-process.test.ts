import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { buildSshSpawnTarget } from "@paperclipai/adapter-utils/ssh";

vi.mock("@paperclipai/adapter-utils/ssh", async (original) => ({
  ...await original<typeof import("@paperclipai/adapter-utils/ssh")>(),
  buildSshSpawnTarget: vi.fn(),
}));
const options = () => ({ cwd: process.cwd(), env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {} });

describe("bridge process lifecycle helper extensions", () => {
  it("keeps bridge stdin open until process exit", async () => {
    const result = await runAdapterExecutionTargetProcess(randomUUID(), { kind: "local" }, "/bin/bash",
      ["-c", 'read -r -t 0.05 data; code=$?; if [ "$code" -gt 128 ]; then printf "held\\n"; else exit 2; fi'],
      { ...options(), keepStdinOpen: true });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("held\n");
  });
  it("preserves default stdin EOF for existing callers", async () => {
    const result = await runChildProcess(randomUUID(), "/bin/cat", [],
      { ...options(), stdin: "input" });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("input");
  });
  it("rejects cancellation before spawn", async () => {
    const controller = new AbortController(); controller.abort(); const onSpawn = vi.fn();
    await expect(runChildProcess(randomUUID(), process.execPath, ["-e", "process.exit(0)"],
      { ...options(), signal: controller.signal, onSpawn })).rejects.toThrow("cancelled");
    expect(onSpawn).not.toHaveBeenCalled();
  });
  it("cancels a running process through the execution-target helper", async () => {
    const controller = new AbortController();
    const result = await runAdapterExecutionTargetProcess(randomUUID(), { kind: "local" }, "/bin/sh",
      ["-c", "while :; do sleep 1; done"], {
        ...options(), signal: controller.signal,
        onSpawn: async () => { controller.abort(); },
      });
    expect(result.signal).toBe("SIGTERM"); expect(result.timedOut).toBe(false);
  });
  it("rechecks cancellation after asynchronous SSH preparation and never connects", async () => {
    const controller = new AbortController(); const cleanup = vi.fn(async () => {}); const onSpawn = vi.fn();
    vi.mocked(buildSshSpawnTarget).mockImplementationOnce(async () => {
      controller.abort();
      return { command: "ssh", args: [], cleanup };
    });
    await expect(runAdapterExecutionTargetProcess(randomUUID(), {
      kind: "remote", transport: "ssh", remoteCwd: "/bridge", spec: {
        host: "execution.invalid", username: "bridge", port: 22, remoteCwd: "/bridge", remoteWorkspacePath: "/bridge",
        strictHostKeyChecking: true, knownHosts: "fake pin", privateKey: "fake key",
      },
    }, "/bridge/cli", ["run"], { ...options(), signal: controller.signal, isolateSsh: true, onSpawn })).rejects.toThrow("cancelled");
    expect(cleanup).toHaveBeenCalledOnce(); expect(onSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(buildSshSpawnTarget).mock.calls[0][0].isolated).toBe(true);
  });
});
