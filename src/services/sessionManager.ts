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

function isSupportedImageMime(mime: string | null | undefined): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes((mime ?? '').split(';')[0].toLowerCase());
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '::1') return true;
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  return false;
}

function safeUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || isPrivateHostname(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function extractMetaMedia(html: string, baseUrl: string): string[] {
  const results: string[] = [];
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = safeUrl(match[1], baseUrl);
      if (url && !results.includes(url)) results.push(url);
    }
  }
  for (const match of html.matchAll(/<(?:img|source)[^>]+(?:src|srcset)=["']([^"']+)["'][^>]*>/gi)) {
    const candidate = match[1].split(',')[0].trim().split(/\s+/)[0];
    const url = safeUrl(candidate, baseUrl);
    if (url && /\.(?:gif|webp|png|jpe?g)(?:[?#]|$)/i.test(url) && !results.includes(url)) results.push(url);
    if (results.length >= 10) break;
  }
  return results.slice(0, 10);
}

async function fetchExternal(url: string): Promise<Response | null> {
  const initial = safeUrl(url);
  if (!initial) return null;
  try {
    const response = await fetch(initial, {
      headers: { 'User-Agent': 'Mozilla/5.0 Leeha/1.0', Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (!safeUrl(response.url || initial)) return null;
    return response;
  } catch { return null; }
}

async function responseToMedia(response: Response): Promise<{ url: string; mime: string } | null> {
  const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!isSupportedImageMime(mime)) return null;
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_MEDIA_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
  return { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, mime: mime! };
}

function discordGifPngUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'cdn.discordapp.com') return null;
    if (!/\.gif$/i.test(url.pathname)) return null;
    // Discord's media proxy can serve a GIF as a static PNG. This keeps
    // animated GIF bytes away from vision providers that only accept stills.
    url.hostname = 'media.discordapp.net';
    url.search = '?format=png';
    return safeUrl(url.href) ?? null;
  } catch { return null; }
}

async function resolveLinkedMedia(url: string): Promise<{ url: string; mime: string } | null> {
  const discordPng = discordGifPngUrl(url);
  if (discordPng) {
    const pngResponse = await fetchExternal(discordPng);
    if (pngResponse?.ok) {
      const png = await responseToMedia(pngResponse);
      if (png?.mime === 'image/png') return png;
    }
  }

  const response = await fetchExternal(url);
  if (!response || !response.ok) return null;
  const responseMime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (isSupportedImageMime(responseMime)) return responseToMedia(response);
  if (!responseMime?.includes('html') && !responseMime?.includes('xhtml')) return null;
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > 2 * 1024 * 1024) return null;
  const finalUrl = safeUrl(response.url || url);
  if (!finalUrl) return null;
  const html = await response.text();
  for (const candidate of extractMetaMedia(html, finalUrl)) {
    const imageResponse = await fetchExternal(candidate);
    if (!imageResponse || !imageResponse.ok) continue;
    const media = await responseToMedia(imageResponse);
    if (media) return media;
  }
  return null;
}

export async function resolveLinkedGifAttachments(text: string): Promise<PromptMediaAttachment[]> {
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  const result: PromptMediaAttachment[] = [];
  const seen = new Set<string>();
  for (const rawUrl of urls.slice(0, 10)) {
    const url = rawUrl.replace(/[),.!?]+$/g, '');
    if (seen.has(url)) continue;
    const resolved = await resolveLinkedMedia(url);
    if (!resolved) continue;
    seen.add(url);
    const extension = resolved.mime === 'image/gif' ? 'gif' : resolved.mime === 'image/webp' ? 'webp' : resolved.mime === 'image/png' ? 'png' : 'jpg';
    result.push({ url: resolved.url, name: `linked.${extension}`, mime: resolved.mime });
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
