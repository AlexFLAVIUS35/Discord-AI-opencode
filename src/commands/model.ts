import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, MessageFlags, ThreadChannel } from 'discord.js';
import { execSync } from 'node:child_process';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';
import { sanitizeModel } from '../utils/stringUtils.js';
import { getAllInstances } from '../services/serveManager.js';
import { getAuthHeaders } from '../services/serverAuth.js';

type ModelInfo = {
  id: string;
  input: string[];
};

let cachedModels: ModelInfo[] = [];
let cacheTimestamp = 0;
let refreshInFlight = false;
const CACHE_TTL_MS = 30_000;

function normalizeInputCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
  }
  if (typeof value === 'string') return [value];
  return [];
}

function parseVerboseModels(output: string): ModelInfo[] {
  const result: ModelInfo[] = [];
  const lines = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  let currentId: string | undefined;
  let jsonLines: string[] = [];
  let depth = 0;
  let inJson = false;

  const flush = () => {
    if (!currentId) return;

    let input: string[] = [];
    if (jsonLines.length) {
      try {
        const metadata = JSON.parse(jsonLines.join('\n')) as { capabilities?: { input?: unknown } };
        input = normalizeInputCapabilities(metadata.capabilities?.input);
      } catch {
        // Keep the model even if one metadata block is malformed.
      }
    }

    result.push({ id: currentId, input });
    currentId = undefined;
    jsonLines = [];
    depth = 0;
    inJson = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const looksLikeModelId = line.includes('/') && !line.startsWith('{') && !line.startsWith('"') && !line.startsWith('}') && !line.startsWith('[');
    if (looksLikeModelId) {
      flush();
      const id = sanitizeModel(line);
      if (id.includes('/')) currentId = id;
      continue;
    }

    if (!currentId) continue;

    jsonLines.push(rawLine);
    for (const char of rawLine) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    inJson = true;

    if (inJson && depth === 0) flush();
  }

  flush();
  return result;
}

async function loadModelsFromServers(): Promise<ModelInfo[]> {
  const result = new Map<string, ModelInfo>();

  for (const instance of getAllInstances()) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/provider`, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) continue;

      const payload = await response.json() as {
        all?: Record<string, { models?: Record<string, { capabilities?: { input?: unknown } }> }> | Array<{ id?: string; models?: Record<string, { capabilities?: { input?: unknown } }> }>;
      };

      if (Array.isArray(payload.all)) {
        for (const provider of payload.all) {
          if (!provider.id) continue;
          for (const [modelId, model] of Object.entries(provider.models ?? {})) {
            const id = sanitizeModel(`${provider.id}/${modelId}`);
            if (!id.includes('/')) continue;
            result.set(id, { id, input: normalizeInputCapabilities(model.capabilities?.input) });
          }
        }
      } else {
        for (const [providerId, provider] of Object.entries(payload.all ?? {})) {
          for (const [modelId, model] of Object.entries(provider.models ?? {})) {
            const id = sanitizeModel(`${providerId}/${modelId}`);
            if (!id.includes('/')) continue;
            result.set(id, { id, input: normalizeInputCapabilities(model.capabilities?.input) });
          }
        }
      }
    } catch { }
  }

  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function loadModelsFromCli(force = false): ModelInfo[] {
  try {
    const output = execSync(`opencode models --verbose${force ? ' --refresh' : ''}`, { encoding: 'utf-8', timeout: 30000 });
    return parseVerboseModels(output);
  } catch {
    return [];
  }
}

async function refreshCatalog(force = false): Promise<ModelInfo[]> {
  if (refreshInFlight) return cachedModels;
  refreshInFlight = true;
  try {
    if (force) {
      try { execSync('opencode models --refresh', { encoding: 'utf-8', timeout: 30000 }); } catch { }
    }

    let models = await loadModelsFromServers();
    if (!models.length) models = loadModelsFromCli(force);

    if (models.length) {
      cachedModels = models;
      cacheTimestamp = Date.now();
    }
    return cachedModels;
  } finally {
    refreshInFlight = false;
  }
}

export async function resolveModelId(modelName: string): Promise<string> {
  const requested = sanitizeModel(modelName.trim());
  if (!requested) return requested;

  // Railway may have a persisted channel model from an older provider catalog.
  // OpenCode currently exposes Gemini's image model without the legacy 302ai/
  // provider prefix, so normalize this known stale ID before consulting the catalog.
  if (requested === '302ai/gemini-2.5-flash-image') {
    const corrected = 'gemini-2.5-flash-image';
    console.log(`[Model Resolver] Remapped stale model ${requested} -> ${corrected}`);
    return corrected;
  }

  const models = await refreshCatalog(false);
  if (!models.length) return requested;

  const exact = models.find(model => model.id === requested);
  if (exact) return exact.id;

  // Older Leeha versions stored provider/model IDs that may no longer match
  // the current OpenCode catalog. OpenCode model references are provider/model,
  // so compare the model portion separately and recover the current provider.
  const separator = requested.indexOf('/');
  const legacyModelId = separator >= 0 ? requested.slice(separator + 1) : requested;
  const candidates = models.filter(model => {
    const currentSeparator = model.id.indexOf('/');
    const currentModelId = currentSeparator >= 0 ? model.id.slice(currentSeparator + 1) : model.id;
    return currentModelId === legacyModelId || currentModelId.endsWith(`/${legacyModelId}`);
  });

  if (candidates.length === 1) {
    console.log(`[Model Resolver] Remapped stale model ${requested} -> ${candidates[0].id}`);
    return candidates[0].id;
  }

  // If several providers expose the same model ID, prefer the same provider
  // that was stored previously before falling back to the first catalog entry.
  if (candidates.length > 1 && separator >= 0) {
    const oldProvider = requested.slice(0, separator);
    const sameProvider = candidates.find(model => model.id.startsWith(`${oldProvider}/`));
    if (sameProvider) {
      console.log(`[Model Resolver] Remapped stale model ${requested} -> ${sameProvider.id}`);
      return sameProvider.id;
    }
    console.log(`[Model Resolver] Remapped stale model ${requested} -> ${candidates[0].id}`);
    return candidates[0].id;
  }

  return requested;
}

function refreshCacheAsync(): void {
  if (refreshInFlight) return;
  void refreshCatalog(false);
}

export function getCachedModels(): string[] {
  if (cachedModels.length === 0) {
    const models = loadModelsFromCli();
    if (models.length) {
      cachedModels = models;
      cacheTimestamp = Date.now();
    }
  } else if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    refreshCacheAsync();
  }
  return cachedModels.map(model => model.id);
}

function getEffectiveChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  return channel?.isThread() ? (channel as ThreadChannel).parentId ?? interaction.channelId : interaction.channelId;
}

function modelsWithInput(input: string): ModelInfo[] {
  return cachedModels.filter(model => model.input.includes(input));
}

export const model: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Manage AI models for the current channel')
    .addSubcommand(subcommand => subcommand.setName('list').setDescription('List all available models'))
    .addSubcommand(subcommand => subcommand.setName('media').setDescription('Show models declared to support image input'))
    .addSubcommand(subcommand => subcommand.setName('text').setDescription('Show models declared to support text input'))
    .addSubcommand(subcommand => subcommand.setName('refresh').setDescription('Refresh the OpenCode model catalog and metadata'))
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('Set the exact OpenCode model for this channel').addStringOption(option => option.setName('name').setDescription('Exact provider/model ID').setRequired(true).setAutocomplete(true))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = await refreshCatalog(true);
      const mediaCount = models.filter(model => model.input.includes('image')).length;
      const textCount = models.filter(model => model.input.includes('text')).length;
      await interaction.editReply(models.length
        ? `✅ Model catalog refreshed. Found **${models.length}** models (**${textCount}** text, **${mediaCount}** image-capable).`
        : '❌ Failed to refresh the OpenCode model catalog.');
      return;
    }

    if (subcommand === 'media' || subcommand === 'text') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (cachedModels.length === 0 || Date.now() - cacheTimestamp > CACHE_TTL_MS) await refreshCatalog(false);

      const input = subcommand === 'media' ? 'image' : 'text';
      const models = modelsWithInput(input);
      const label = subcommand === 'media' ? '🖼️ Image-capable models' : '📝 Text-capable models';
      await interaction.editReply(models.length
        ? `### ${label}\n\n${models.map(model => `• \`${model.id}\``).join('\n')}`.slice(0, 1900)
        : `No models in the OpenCode catalog declare **${input}** input support. Try \`/model refresh\` first.`);
      return;
    }

    if (subcommand === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = getCachedModels();
      if (!models.length) { await interaction.editReply('No models found. Try `/model refresh`.'); return; }
      const groups: Record<string, string[]> = {};
      for (const m of models) { const provider = m.split('/')[0]; (groups[provider] ??= []).push(m); }
      let response = '### 🤖 Available Models\n\n'; let first = true;
      for (const [provider, providerModels] of Object.entries(groups)) {
        const block = `**${provider}**\n${providerModels.map(m => `• \`${m}\``).join('\n')}\n\n`;
        if (response.length + block.length > 1800 && response.length > 0) {
          if (first) { await interaction.editReply(response); first = false; } else await interaction.followUp({ content: response, flags: MessageFlags.Ephemeral });
          response = '';
        }
        response += block;
      }
      if (response) first ? await interaction.editReply(response) : await interaction.followUp({ content: response, flags: MessageFlags.Ephemeral });
      return;
    }

    const modelName = interaction.options.getString('name', true).trim();
    const channelId = getEffectiveChannelId(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const availableModels = getCachedModels();
    if (availableModels.length > 0 && !availableModels.includes(modelName)) {
      const resolved = await resolveModelId(modelName);
      if (resolved === modelName) {
        await interaction.editReply(`❌ Model \`${modelName}\` not found in the current OpenCode catalog.\nUse \`/model refresh\`, then try again.`);
        return;
      }
      dataStore.setChannelModel(channelId, resolved);
      await interaction.editReply(`✅ Model for this channel set to \`${resolved}\` (updated from the stale ID).`);
      return;
    }
    dataStore.setChannelModel(channelId, modelName);
    await interaction.editReply(`✅ Model for this channel set to \`${modelName}\`.`);
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const filtered = getCachedModels().filter(m => m.toLowerCase().includes(focused)).slice(0, 25);
    try { await interaction.respond(filtered.map(m => ({ name: m, value: m }))); } catch { }
  }
};
