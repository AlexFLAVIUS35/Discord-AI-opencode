import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  ThreadChannel,
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';
import { sanitizeModel } from '../utils/stringUtils.js';
import { getAllInstances } from '../services/serveManager.js';
import { getAuthHeaders } from '../services/serverAuth.js';

type ModelInfo = {
  id: string;
  input: string[];
  runtimeProviderID?: string;
};

let catalog: ModelInfo[] = dataStore.getModelCatalog();
let refreshPromise: Promise<ModelInfo[]> | undefined;

function normalizeInput(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
  }
  if (typeof value === 'string') return [value];
  return [];
}

type ProviderModel = {
  capabilities?: { input?: unknown };
  modelID?: unknown;
};

type ProviderEntry = {
  models?: Record<string, ProviderModel>;
};

function addProviderModels(
  target: Map<string, ModelInfo>,
  providerId: string,
  models: Record<string, ProviderModel> | undefined,
  connectedProviders: Set<string>,
): void {
  if (!providerId || !models) return;

  for (const [modelId, model] of Object.entries(models)) {
    const id = sanitizeModel(`${providerId}/${modelId}`);
    if (!id.includes('/')) continue;

    const runtimeProviderID = connectedProviders.has(providerId) ? providerId : undefined;

    target.set(id, {
      id,
      input: normalizeInput(model?.capabilities?.input),
      runtimeProviderID,
    });
  }
}

function addNativeGoogleModels(target: Map<string, ModelInfo>): void {
  if (!process.env['GOOGLE_GENERATIVE_AI_API_KEY']?.trim()) return;

  const models: Array<[string, string[]]> = [
    ['google/gemini-3.7-flash', ['text']],
    ['google/gemini-3.6-flash', ['text']],
    ['google/gemini-3.5-flash', ['text']],
    ['google/gemini-3.5-flash-lite', ['text']],
    ['google/gemini-3.1-flash-lite', ['text']],
    ['google/gemini-2.5-flash', ['text']],
    ['google/gemini-2.5-flash-lite', ['text']],
    ['google/gemini-2.5-pro', ['text']],
  ];

  for (const [id, input] of models) {
    target.set(id, { id, input, runtimeProviderID: 'google' });
  }
}

async function readServerCatalog(port: number): Promise<ModelInfo[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/provider`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const payload = await response.json() as {
      all?:
        | Record<string, ProviderEntry>
        | Array<{ id?: string; models?: Record<string, ProviderModel> }>;
      connected?: string[];
    };

    const connectedProviders = new Set(
      Array.isArray(payload.connected)
        ? payload.connected.filter((id): id is string => typeof id === 'string')
        : [],
    );

    const models = new Map<string, ModelInfo>();
    const allProviders: Array<{ id: string; models?: Record<string, ProviderModel> }> = [];

    if (Array.isArray(payload.all)) {
      for (const provider of payload.all) {
        if (provider.id) allProviders.push({ id: provider.id, models: provider.models });
      }
    } else {
      for (const [providerId, provider] of Object.entries(payload.all ?? {})) {
        allProviders.push({ id: providerId, models: provider.models });
      }
    }

    for (const provider of allProviders) {
      addProviderModels(models, provider.id, provider.models, connectedProviders);
    }

    addNativeGoogleModels(models);

    return [...models.values()];
  } catch {
    return [];
  }
}

export async function refreshModelCatalog(): Promise<ModelInfo[]> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const instances = getAllInstances();
    const providers = await Promise.all(instances.map(instance => readServerCatalog(instance.port)));
    const merged = new Map<string, ModelInfo>();

    // Start with the persisted catalog so a transient /provider failure never
    // destroys the last known-good provider/model IDs across process restarts.
    for (const model of dataStore.getModelCatalog()) {
      merged.set(model.id, model);
    }

    // Also preserve the in-memory catalog in case another refresh populated it
    // since the persisted snapshot was read.
    for (const model of catalog) {
      merged.set(model.id, model);
    }

    for (const models of providers) {
      for (const model of models) {
        const existing = merged.get(model.id);
        if (!existing || model.input.length > existing.input.length || (!existing.runtimeProviderID && model.runtimeProviderID)) {
          merged.set(model.id, model);
        }
      }
    }

    addNativeGoogleModels(merged);

    catalog = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    dataStore.setModelCatalog(catalog);
    return catalog;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = undefined;
  }
}

export function getCachedModels(): string[] {
  return catalog.map(model => model.id);
}

export function resolveCatalogModel(model: string): { providerID: string; modelID: string } | null {
  const clean = sanitizeModel(model);
  const separator = clean.indexOf('/');
  if (separator === -1) return null;

  const catalogProviderID = clean.slice(0, separator);
  const modelID = clean.slice(separator + 1);
  const selected = catalog.find(entry => entry.id === clean);

  return {
    providerID: selected?.runtimeProviderID ?? catalogProviderID,
    modelID,
  };
}

function getEffectiveChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  return channel?.isThread()
    ? (channel as ThreadChannel).parentId ?? interaction.channelId
    : interaction.channelId;
}

function splitForDiscord(text: string, maxLength = 1900): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > maxLength) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function formatCatalog(models: ModelInfo[]): string[] {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const separator = model.id.indexOf('/');
    const provider = separator === -1 ? model.id : model.id.slice(0, separator);
    const list = groups.get(provider) ?? [];
    list.push(model.id);
    groups.set(provider, list);
  }

  const lines = ['### 🤖 Available Models', ''];
  for (const [provider, providerModels] of groups) {
    lines.push(`**${provider}**`);
    for (const model of providerModels) lines.push(`• \\`${model}\``);
    lines.push('');
  }
  return splitForDiscord(lines.join('\n'));
}

export const model: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Manage AI models for the current channel')
    .addSubcommand(subcommand => subcommand.setName('list').setDescription('List all models available from OpenCode'))
    .addSubcommand(subcommand => subcommand.setName('media').setDescription('Show models that support image input'))
    .addSubcommand(subcommand => subcommand.setName('text').setDescription('Show models that support text input'))
    .addSubcommand(subcommand => subcommand.setName('refresh').setDescription('Re-read the model catalog from OpenCode'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the exact OpenCode provider/model for this channel')
        .addStringOption(option =>
          option
            .setName('name')
            .setDescription('Exact provider/model ID')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = await refreshModelCatalog();
      if (!models.length) {
        await interaction.editReply('❌ OpenCode returned no models. Make sure the OpenCode server is running and its provider catalog is available.');
        return;
      }

      const textCount = models.filter(model => model.input.includes('text')).length;
      const imageCount = models.filter(model => model.input.includes('image')).length;
      await interaction.editReply(
        `✅ Model catalog rebuilt from OpenCode. Found **${models.length}** models (**${textCount}** text, **${imageCount}** image-capable).`,
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const models = await refreshModelCatalog();

    if (!models.length) {
      await interaction.editReply('❌ No models were returned by the OpenCode server. Check the OpenCode provider catalog/configuration.');
      return;
    }

    if (subcommand === 'list') {
      const chunks = formatCatalog(models);
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'media' || subcommand === 'text') {
      const input = subcommand === 'media' ? 'image' : 'text';
      const matching = models.filter(model => model.input.includes(input));
      const label = input === 'image' ? '🖼️ Image-capable models' : '📝 Text-capable models';

      if (!matching.length) {
        await interaction.editReply(`No models in OpenCode declare **${input}** input support.`);
        return;
      }

      const chunks = splitForDiscord([`### ${label}`, '', ...matching.map(model => `• \\`${model.id}\``)].join('\n'));
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      return;
    }

    const modelName = sanitizeModel(interaction.options.getString('name', true).trim());
    const selected = models.find(model => model.id === modelName);

    if (!selected) {
      await interaction.editReply(`❌ Model \\`${modelName}\` is not in the OpenCode catalog. Use the exact \\`provider/model\` ID shown by \\`/model list\`.`);
      return;
    }

    const channelId = getEffectiveChannelId(interaction);
    dataStore.setChannelModel(channelId, selected.id);
    await interaction.editReply(`✅ Model for this channel set to \\`${selected.id}\`.`);
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toLowerCase();
    if (!catalog.length && !refreshPromise) await refreshModelCatalog();

    const filtered = catalog.filter(model => model.id.toLowerCase().includes(focused));
    try {
      await interaction.respond(filtered.slice(0, 25).map(model => ({ name: model.id, value: model.id })));
    } catch {
      // Discord can close an autocomplete interaction before the response arrives.
    }
  },
};
