import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";
import sharp from "sharp";

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

function isDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (hostname === 'cdn.discordapp.com' || hostname === 'media.discordapp.net') && /^\/attachments\//i.test(url.pathname);
  } catch { return false; }
}

async function refreshDiscordAttachmentUrl(url: string): Promise<string | null> {
  if (!isDiscordAttachmentUrl(url)) return null;
  const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('[Media] Discord CDN refresh skipped: no DISCORD_BOT_TOKEN/DISCORD_TOKEN');
    return null;
  }
  try {
    const response = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Leeha/1.0 (+https://github.com/AlexFLAVIUS35/Discord-AI-opencode)',
      },
      body: JSON.stringify({ attachment_urls: [url] }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      console.error(`[Media] Discord CDN refresh failed: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json() as { refreshed_urls?: Array<{ original?: string; refreshed?: string }> };
    const refreshed = data.refreshed_urls?.find(item => item.original === url)?.refreshed ?? data.refreshed_urls?.[0]?.refreshed;
    if (!refreshed) {
      console.error('[Media] Discord CDN refresh returned no refreshed URL');
      return null;
    }
    return refreshed;
  } catch (error) {
    console.error('[Media] Discord CDN refresh error:', error instanceof Error ? error.message : error);
    return null;
  }
}

function isDiscordGifUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname.toLowerCase() === 'cdn.discordapp.com' || url.hostname.toLowerCase() === 'media.discordapp.net') && /\.gif$/i.test(url.pathname);
  } catch { return false; }
}

async function discordGifToPng(response: Response): Promise<{ url: string; mime: string } | null> {
  try {
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MEDIA_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
    const png = await sharp(bytes, { pages: 1, page: 0 }).png().toBuffer();
    if (png.byteLength > MAX_MEDIA_BYTES) return null;
    return { url: `data:image/png;base64,${png.toString('base64')}`, mime: 'image/png' };
  } catch (error) {
    console.error('[Media] Failed to convert Discord GIF to PNG:', error instanceof Error ? error.message : error);
    return null;
  }
}

function isKlipyPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'klipy.com' && /^\/gifs\//i.test(url.pathname);
  } catch { return false; }
}

function klipySlug(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/gifs\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

function findKlipyMediaUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKlipyMediaUrl(item);
      if (found) return found;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  for (const key of ['gif', 'mediumgif', 'tinygif', 'nanogif', 'url']) {
    const candidate = object[key];
    if (typeof candidate === 'string' && /^https:\/\/static\d?\.klipy\.com\/.+\.(?:gif|webp|png|jpe?g)(?:[?#].*)?$/i.test(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const found = findKlipyMediaUrl(candidate);
      if (found) return found;
    }
  }
  for (const candidate of Object.values(object)) {
    const found = findKlipyMediaUrl(candidate);
    if (found) return found;
  }
  return null;
}

async function resolveKlipyGif(url: string): Promise<{ url: string; mime: string } | null> {
  const appKey = process.env.KLIPY_API_KEY ?? process.env.KLIPY_APP_KEY;
  const slug = klipySlug(url);
  if (!appKey || !slug) {
    console.error(`[Media] KLIPY link needs KLIPY_API_KEY/KLIPY_APP_KEY: ${url}`);
    return null;
  }
  try {
    const endpoint = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(appKey)}/gifs/items`);
    endpoint.searchParams.set('slugs', slug);
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'Leeha/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      console.error(`[Media] KLIPY API failed for ${url}: ${response.status} ${response.statusText}`);
      return null;
    }
    const data: unknown = await response.json();
    const mediaUrl = findKlipyMediaUrl(data);
    if (!mediaUrl) {
      console.error(`[Media] KLIPY API returned no GIF media for ${url}`);
      return null;
    }
    const mediaResponse = await fetchExternal(mediaUrl);
    if (!mediaResponse || !mediaResponse.ok) {
      console.error(`[Media] Failed to fetch KLIPY media: ${mediaUrl} (${mediaResponse?.status ?? 'network error'})`);
      return null;
    }
    return responseToMedia(mediaResponse);
  } catch (error) {
    console.error('[Media] Failed to resolve KLIPY GIF:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function resolveLinkedMedia(url: string): Promise<{ url: string; mime: string } | null> {
  if (isKlipyPageUrl(url)) {
    const klipyMedia = await resolveKlipyGif(url);
    if (klipyMedia) return klipyMedia;
  }
  const refreshedDiscordUrl = await refreshDiscordAttachmentUrl(url);
  const fetchUrl = refreshedDiscordUrl ?? url;
  const response = await fetchExternal(fetchUrl);
  if (!response || !response.ok) {
    console.error(`[Media] Failed to fetch linked media: ${url} (${response?.status ?? 'network error'})`);
    return null;
  }
  const responseMime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (isDiscordGifUrl(fetchUrl) && responseMime === 'image/gif') {
    const png = await discordGifToPng(response);
    if (png) return png;
    return null;
  }
  if (isSupportedImageMime(responseMime)) return responseToMedia(response);
  if (!responseMime?.includes('html') && !responseMime?.includes('xhtml')) return null;
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > 2 * 1024 * 1024) return null;
  const finalUrl = safeUrl(response.url || fetchUrl);
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

function decodeDataUrl(value: string): { bytes: Buffer; mime: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!isSupportedImageMime(mime)) return null;
  try {
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
    return { bytes, mime };
  } catch { return null; }
}

async function mediaParts(attachments: PromptMediaAttachment[]): Promise<{ type: string; mime: string; url: string }[]> {
  const parts: { type: string; mime: string; url: string }[] = [];
  for (const attachment of attachments.slice(0, 10)) {
    try {
      const decoded = decodeDataUrl(attachment.url);
      if (decoded) {
        parts.push({ type: 'file', mime: decoded.mime, url: attachment.url });
        continue;
      }
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
