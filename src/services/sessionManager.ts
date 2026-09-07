import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const threadSseClients = new Map<string, SSEClient>();
const activeExecutions = new Set<string>();

function jsonHeaders(): Record<string, string> { return { "Content-Type": "application/json", ...getAuthHeaders() }; }
export function beginExecution(threadId: string): boolean { activeExecutions.add(threadId); return true; }
export function endExecution(threadId: string): void { activeExecutions.delete(threadId); }
export function isExecutionActive(threadId: string): boolean { return activeExecutions.has(threadId); }

export async function createSession(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/session`, { method: "POST", headers: jsonHeaders(), body: "{}" });
  if (!response.ok) { assertNotAuthError(response.status, "Failed to create session"); throw new Error(`Failed to create session: ${response.status} ${response.statusText}`); }
  const data = await response.json(); if (!data.id) throw new Error("Invalid session response: missing id"); return data.id;
}
function parseModelString(model: string): { providerID: string; modelID: string } | null { const clean = sanitizeModel(model); const slashIndex = clean.indexOf("/"); if (slashIndex === -1) return null; return { providerID: clean.slice(0, slashIndex), modelID: clean.slice(slashIndex + 1) }; }
export interface PromptMediaAttachment { url: string; name: string; mime?: string | null; }

const GIF_LINK_HOSTS = new Set(["tenor.com", "www.tenor.com", "tenor.co", "www.tenor.co", "klipy.com", "www.klipy.com", "klipy.app", "www.klipy.app"]);

function isSupportedImageMime(mime: string | null | undefined): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes((mime ?? '').split(';')[0].toLowerCase());
}

function extractMetaImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try { return new URL(match[1], 'https://example.com').href; } catch { }
    }
  }
  return null;
}

async function resolveGifLink(url: string): Promise<{ url: string; mime?: string } | null> {
  try {
    const parsed = new URL(url);
    if (!GIF_LINK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Leeha/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const finalMime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
    if (isSupportedImageMime(finalMime)) return { url: response.url || url, mime: finalMime! };
    const html = await response.text();
    const imageUrl = extractMetaImage(html);
    if (!imageUrl) return null;
    const imageResponse = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 Leeha/1.0', Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (!imageResponse.ok) return null;
    const mime = imageResponse.headers.get('content-type')?.split(';')[0].toLowerCase();
    return isSupportedImageMime(mime) ? { url: imageResponse.url || imageUrl, mime: mime! } : null;
  } catch (error) {
    console.error(`[Media] Failed to resolve GIF link ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function resolveLinkedGifAttachments(text: string): Promise<PromptMediaAttachment[]> {
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  const result: PromptMediaAttachment[] = [];
  const seen = new Set<string>();
  for (const rawUrl of urls.slice(0, 10)) {
    const url = rawUrl.replace(/[),.!?]+$/g, '');
    if (seen.has(url)) continue;
    const resolved = await resolveGifLink(url);
    if (!resolved) continue;
    seen.add(url);
    result.push({ url: resolved.url, name: 'linked.gif', mime: resolved.mime });
  }
  return result;
}

async function mediaParts(attachments: PromptMediaAttachment[]): Promise<{ type: string; mime: string; url: string }[]> {
  const parts: { type: string; mime: string; url: string }[] = [];
  for (const attachment of attachments.slice(0, 10)) {
    try {
      const response = await fetch(attachment.url); if (!response.ok) continue;
      const contentLength = Number(response.headers.get('content-length') ?? 0); if (contentLength > MAX_MEDIA_BYTES) continue;
      const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > MAX_MEDIA_BYTES) continue;
      const mime = attachment.mime || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      if (!isSupportedImageMime(mime)) continue;
      parts.push({ type: 'file', mime, url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
    } catch (error) { console.error(`[Media] Failed to download ${attachment.name}:`, error instanceof Error ? error.message : error); }
  }
  return parts;
}
export async function sendPrompt(port: number, sessionId: string, text: string, model?: string, attachments: PromptMediaAttachment[] = []): Promise<void> {
  const parts: { type: string; text?: string; mime?: string; url?: string }[] = [{ type: "text", text }];
  if (attachments.length) parts.push(...await mediaParts(attachments));
  const body: { parts: typeof parts; model?: { providerID: string; modelID: string } } = { parts };
  if (model) { const parsedModel = parseModelString(model); if (parsedModel) body.model = parsedModel; }
  const response = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/prompt_async`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
  if (!response.ok) { const responseBody = await response.text(); assertNotAuthError(response.status, "Failed to send prompt"); throw new Error(`Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`); }
}
export async function validateSession(port: number, sessionId: string): Promise<boolean> { try { const response = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, { method: "GET", headers: jsonHeaders() }); if (!response.ok) assertNotAuthError(response.status, "Failed to validate session"); return response.ok; } catch { return false; } }
export async function getSessionInfo(port: number, sessionId: string): Promise<SessionInfo | null> { try { const response = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, { headers: jsonHeaders() }); if (!response.ok) { assertNotAuthError(response.status, "Failed to get session info"); return null; } const data = await response.json(); return { id: data.id, title: data.title ?? "" }; } catch { return null; } }
export interface SessionInfo { id: string; title: string; }
export async function listSessions(port: number): Promise<SessionInfo[]> { try { const response = await fetch(`http://127.0.0.1:${port}/session`, { headers: jsonHeaders() }); if (!response.ok) { assertNotAuthError(response.status, "Failed to list sessions"); return []; } const data = await response.json(); return Array.isArray(data) ? data.map((s: { id: string; title?: string }) => ({ id: s.id, title: s.title ?? "" })) : []; } catch { return []; } }
export async function abortSession(port: number, sessionId: string): Promise<boolean> { try { const response = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/abort`, { method: "POST", headers: getAuthHeaders() }); if (!response.ok) assertNotAuthError(response.status, "Failed to abort session"); return response.ok; } catch { return false; } }
export function getSessionForThread(threadId: string): { sessionId: string; projectPath: string; port: number } | undefined { const session = dataStore.getThreadSession(threadId); if (!session) return undefined; return { sessionId: session.sessionId, projectPath: session.projectPath, port: session.port }; }
export function setSessionForThread(threadId: string, sessionId: string, projectPath: string, port: number): void { const existing = dataStore.getThreadSession(threadId); const now = Date.now(); dataStore.setThreadSession({ threadId, sessionId, projectPath, port, createdAt: existing?.createdAt ?? now, lastUsedAt: now }); }
export async function ensureSessionForThread(threadId: string, projectPath: string, port: number): Promise<string> { const existingSession = getSessionForThread(threadId); if (existingSession && existingSession.projectPath === projectPath && existingSession.port === port) { setSessionForThread(threadId, existingSession.sessionId, projectPath, port); return existingSession.sessionId; } if (existingSession && existingSession.projectPath === projectPath) { const isValid = await validateSession(port, existingSession.sessionId); if (isValid) { setSessionForThread(threadId, existingSession.sessionId, projectPath, port); return existingSession.sessionId; } } const sessionId = await createSession(port); setSessionForThread(threadId, sessionId, projectPath, port); return sessionId; }
export function updateSessionLastUsed(threadId: string): void { dataStore.updateThreadSessionLastUsed(threadId); }
export function clearSessionForThread(threadId: string): void { dataStore.clearThreadSession(threadId); }
export function setSseClient(threadId: string, client: SSEClient): void { threadSseClients.set(threadId, client); }
export function getSseClient(threadId: string): SSEClient | undefined { return threadSseClients.get(threadId); }
export function clearSseClient(threadId: string): void { threadSseClients.delete(threadId); }
