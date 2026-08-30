import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, MessageFlags, ThreadChannel } from 'discord.js';
import { execSync, exec } from 'node:child_process';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';
import { sanitizeModel } from '../utils/stringUtils.js';

let cachedModels: string[] = [];
let cacheTimestamp = 0;
let refreshInFlight = false;
const CACHE_TTL_MS = 30_000;

function loadModels(force = false): string[] {
  try {
    const output = execSync(force ? 'opencode models --refresh' : 'opencode models', { encoding: 'utf-8', timeout: 30000 });
    cachedModels = output.split('\n').map(sanitizeModel).filter(m => m && m.includes('/'));
    cacheTimestamp = Date.now();
  } catch { }
  return cachedModels;
}

function refreshCacheAsync(): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  exec('opencode models', { encoding: 'utf-8', timeout: 15000 }, (error, stdout) => {
    refreshInFlight = false;
    if (!error && stdout) {
      cachedModels = stdout.split('\n').map(sanitizeModel).filter(m => m && m.includes('/'));
      cacheTimestamp = Date.now();
    }
  });
}

export function getCachedModels(): string[] {
  if (cachedModels.length === 0) return loadModels();
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) refreshCacheAsync();
  return cachedModels;
}

function getEffectiveChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  return channel?.isThread() ? (channel as ThreadChannel).parentId ?? interaction.channelId : interaction.channelId;
}

function likelyMediaModels(models: string[]): string[] {
  const terms = ['vision', 'vl', 'gemini', 'claude', 'gpt-4o', 'gpt-5', 'qwen', 'kimi', 'minimax'];
  return models.filter(name => terms.some(term => name.toLowerCase().includes(term)));
}

export const model: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Manage AI models for the current channel')
    .addSubcommand(subcommand => subcommand.setName('list').setDescription('List all available models'))
    .addSubcommand(subcommand => subcommand.setName('media').setDescription('Show models likely to support images/GIFs'))
    .addSubcommand(subcommand => subcommand.setName('refresh').setDescription('Refresh the OpenCode model catalog'))
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('Set the exact OpenCode model for this channel').addStringOption(option => option.setName('name').setDescription('Exact provider/model ID').setRequired(true).setAutocomplete(true))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = loadModels(true);
      await interaction.editReply(models.length ? `✅ Model catalog refreshed. Found **${models.length}** models.` : '❌ Failed to refresh the OpenCode model catalog.');
      return;
    }

    if (subcommand === 'media') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const models = likelyMediaModels(getCachedModels());
      await interaction.editReply(models.length ? `### 🖼️ Likely media-capable models\n\n${models.map(m => `• \`${m}\``).join('\n')}`.slice(0, 1900) : 'No likely media-capable models detected. Try `/model refresh` first.');
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
      await interaction.editReply(`❌ Model \`${modelName}\` not found in the current OpenCode catalog.\nUse \`/model refresh\`, then try again.`);
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
