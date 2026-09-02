import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Server } from "node:net";
import { delimiter, join } from "node:path";
import type { ServeInstance } from "../types/index.js";
import { getPortConfig } from "./configStore.js";
import { getAuthHeaders, isAuthEnabled } from "./serverAuth.js";

const DEFAULT_PORT_MIN = 14097;
const DEFAULT_PORT_MAX = 14200;
const WINDOWS_OPENCODE_COMMANDS = ["opencode.cmd", "opencode.exe", "opencode"];
const POSIX_OPENCODE_COMMANDS = ["opencode"];
const READY_POLL_INTERVAL_MS = 50;

const instances = new Map<string, ServeInstance>();

function getOpencodeCommandCandidates(): string[] { return process.platform === "win32" ? WINDOWS_OPENCODE_COMMANDS : POSIX_OPENCODE_COMMANDS; }
function resolveCommandFromPath(command: string, pathValue?: string): string | undefined {
  if (!pathValue) return undefined;
  for (const pathEntry of pathValue.split(delimiter)) { if (!pathEntry) continue; const resolved = join(pathEntry, command); if (existsSync(resolved)) return resolved; }
  return undefined;
}
function resolveOpencodeCommand(env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH ?? env.Path;
  for (const command of getOpencodeCommandCandidates()) { const resolved = resolveCommandFromPath(command, pathValue); if (resolved) return resolved; }
  return getOpencodeCommandCandidates()[0];
}
function formatSpawnError(error: Error, command: string, projectPath: string): string {
  const spawnError = error as NodeJS.ErrnoException;
  if (!existsSync(projectPath)) return `Project path does not exist or is not accessible: ${projectPath}`;
  if (spawnError.code === "ENOENT") return `OpenCode executable not found: ${command}. Ensure OpenCode is installed and available in PATH for this service.`;
  if (spawnError.code === "EACCES") return `OpenCode executable is not accessible: ${command}. Check file permissions and service user access.`;
  return spawnError.message || "Failed to spawn opencode process";
}
function isPortAvailable(port: number): Promise<boolean> { return new Promise((resolve) => { const server = new Server(); server.once("error", () => resolve(false)); server.once("listening", () => server.close(() => resolve(true))); server.listen(port, "127.0.0.1"); }); }
async function isOrphanedServerRunning(port: number): Promise<boolean> { try { await fetch(`http://127.0.0.1:${port}/session`, { headers: getAuthHeaders(), signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } }
async function findAvailablePort(): Promise<number> {
  const config = getPortConfig(); const min = config?.min ?? DEFAULT_PORT_MIN; const max = config?.max ?? DEFAULT_PORT_MAX;
  for (let port = min; port <= max; port++) { const usedPorts = new Set(Array.from(instances.values()).filter((i) => !i.exited).map((i) => i.port)); if (usedPorts.has(port)) continue; if (await isOrphanedServerRunning(port)) continue; if (await isPortAvailable(port)) return port; }
  throw new Error(`No available ports in range ${min}-${max}`);
}
function cleanupInstance(key: string): void { instances.delete(key); }
function getPermissionConfig(storageEnabled: boolean): string {
  // Web access is deliberately read-only: websearch discovers sources and webfetch
  // retrieves pages, while shell/edit tools remain unavailable to the Discord agent.
  const permission = storageEnabled
    ? { "*": "deny", read: "allow", edit: "allow", glob: "allow", grep: "allow", list: "allow", external_directory: "deny", bash: "deny", task: "deny", skill: "deny", lsp: "deny", question: "deny", webfetch: "allow", websearch: "allow" }
    : { "*": "deny", webfetch: "allow", websearch: "allow" };
  return JSON.stringify({ "$schema": "https://opencode.ai/config.json", permission });
}

// A project has one OpenCode server regardless of the selected model.
// The model is a per-prompt setting, so it must never be part of the server
// identity. Otherwise changing /model would create a different server and make
// the existing Discord conversation/session disappear from the new server.
function getInstanceKey(projectPath: string, storageEnabled = false): string {
  return `${projectPath}:${storageEnabled ? "storage" : "chat"}`;
}

export async function spawnServe(projectPath: string, _model?: string, storageEnabled = false): Promise<number> {
  const key = getInstanceKey(projectPath, storageEnabled);
  const existing = instances.get(key); if (existing && !existing.exited) return existing.port; if (existing?.exited) cleanupInstance(key);
  const port = await findAvailablePort(); const args = ["serve", "--port", port.toString()];
  const env = { ...process.env, OPENCODE_ENABLE_EXA: "1", OPENCODE_CONFIG_CONTENT: getPermissionConfig(storageEnabled) }; const command = resolveOpencodeCommand(env);
  console.log(`[opencode] Spawning: ${command} ${args.join(" ")}`); console.log(`[opencode] Working directory: ${projectPath}`); console.log(`[opencode] Storage access: ${storageEnabled ? "ENABLED" : "DISABLED"}`); console.log(`[opencode] Web search: ENABLED (OpenCode websearch + webfetch)`);
  const child = spawn(command, args, { cwd: projectPath, env, stdio: ["inherit", "pipe", "pipe"] }); const instance: ServeInstance = { port, process: child, startTime: Date.now(), exited: false }; instances.set(key, instance);
  let stderrBuffer = ""; let stdoutBuffer = "";
  child.stdout?.on("data", (data) => { const text = data.toString(); stdoutBuffer = (stdoutBuffer + text).slice(-2000); console.log(`[opencode stdout] ${text.trim()}`); });
  child.stderr?.on("data", (data) => { const text = data.toString(); stderrBuffer = (stderrBuffer + text).slice(-2000); console.error(`[opencode stderr] ${text.trim()}`); });
  child.on("exit", (code) => { const inst = instances.get(key); if (!inst) return; inst.exited = true; inst.exitCode = code; if (code !== 0 && code !== null) inst.exitError = stderrBuffer.trim() || stdoutBuffer.trim() || `Process exited with code ${code}`; });
  child.on("error", (error) => { const inst = instances.get(key); if (!inst) return; inst.exited = true; inst.exitError = formatSpawnError(error, command, projectPath); });
  return port;
}
export function getPort(projectPath: string, _model?: string, storageEnabled = false): number | undefined { return instances.get(getInstanceKey(projectPath, storageEnabled))?.port; }
export function stopServe(projectPath: string, _model?: string, storageEnabled = false): boolean { const key = getInstanceKey(projectPath, storageEnabled); const instance = instances.get(key); if (!instance) return false; instance.process.kill(); cleanupInstance(key); return true; }
export async function waitForReady(port: number, timeout = 30000, projectPath?: string, _model?: string, storageEnabled = false): Promise<void> {
  const start = Date.now(); const url = `http://127.0.0.1:${port}/session`; const key = projectPath ? getInstanceKey(projectPath, storageEnabled) : null;
  while (Date.now() - start < timeout) {
    if (key) { const instance = instances.get(key); if (instance?.exited) { const errorMsg = instance.exitError || `opencode serve exited with code ${instance.exitCode}`; cleanupInstance(key); throw new Error(`opencode serve failed to start: ${errorMsg}`); } }
    try { const response = await fetch(url, { headers: getAuthHeaders() }); if (response.ok) return; if (response.status === 401 || response.status === 403) { const hint = isAuthEnabled() ? "credentials were rejected by the opencode server. Verify the configured server credentials." : "opencode server requires authentication but credentials are not configured."; throw new Error(`opencode serve is running on port ${port} but ${hint}`); } } catch (err) { if (err instanceof Error && err.message.startsWith("opencode serve is running on port")) throw err; }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Service at port ${port} failed to become ready within ${timeout}ms.`);
}
export function stopAll(): void { for (const [key, instance] of instances) { instance.process.kill(); cleanupInstance(key); } }
export function getAllInstances(): Array<{ key: string; port: number }> { return Array.from(instances.entries()).map(([key, instance]) => ({ key, port: instance.port })); }
export function getInstanceState(projectPath: string, _model?: string, storageEnabled = false): { exited: boolean; exitCode?: number | null; exitError?: string } | undefined { const instance = instances.get(getInstanceKey(projectPath, storageEnabled)); if (!instance) return undefined; return { exited: instance.exited ?? false, exitCode: instance.exitCode, exitError: instance.exitError }; }