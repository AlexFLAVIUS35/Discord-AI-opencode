import { ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './index.js';
import * as dataStore from '../services/dataStore.js';
import * as guildPersonality from '../services/guildPersonalityStore.js';

const MAX_PERSONALITY_LENGTH = 2000;

function isGuildAdmin(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.guildId && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

export const personality: Command = {
  data: new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Manage your AI personality')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set or replace your personal personality')
      .addStringOption(option => option
        .setName('personality')
        .setDescription('How you want the AI to behave with you')
        .setRequired(true)
        .setMaxLength(MAX_PERSONALITY_LENGTH)))
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View your current personality'))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Remove your saved personality'))
    .addSubcommandGroup(group => group
      .setName('all')
      .setDescription('Manage the personality for everyone in this server')
      .addSubcommand(sub => sub
        .setName('on')
        .setDescription('Enable the server-wide personality'))
      .addSubcommand(sub => sub
        .setName('off')
        .setDescription('Disable the server-wide personality and allow custom personalities'))
      .addSubcommand(sub => sub
        .setName('set')
        .setDescription('Set the server-wide personality and enable it')
        .addStringOption(option => option
          .setName('personality')
          .setDescription('Personality enforced for everyone in this server')
          .setRequired(true)
          .setMaxLength(MAX_PERSONALITY_LENGTH)))
      .addSubcommand(sub => sub
        .setName('reset')
        .setDescription('Remove and disable the server-wide personality'))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    const guildId = interaction.guildId;

    if (group === 'all') {
      if (!guildId) {
        await interaction.reply({ content: '❌ Server-wide personality can only be used inside a server.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isGuildAdmin(interaction)) {
        await interaction.reply({ content: '❌ Only server administrators can manage the server-wide personality.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'set') {
        const value = interaction.options.getString('personality', true).trim();
        guildPersonality.set(guildId, value);
        await interaction.reply({ content: '🧠 **Server-wide personality enabled.** Everyone in this server will use it, and personal personalities are ignored until `/personality all off`.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'on') {
        if (!guildPersonality.enable(guildId)) {
          await interaction.reply({ content: '❌ No server-wide personality is saved. Use `/personality all set` first.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: '🟢 **Server-wide personality enabled.** Personal personalities are ignored for everyone here.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'off') {
        guildPersonality.disable(guildId);
        await interaction.reply({ content: '🔴 **Server-wide personality disabled.** Users may use their own `/personality set` again.', flags: MessageFlags.Ephemeral });
        return;
      }

      guildPersonality.reset(guildId);
      await interaction.reply({ content: '🧹 **Server-wide personality reset.** It has been removed and disabled.', flags: MessageFlags.Ephemeral });
      return;
    }

    const userId = interaction.user.id;

    if (subcommand === 'set') {
      if (guildId && guildPersonality.isEnabled(guildId)) {
        await interaction.reply({ content: '🔒 **Server-wide personality is enabled.** You cannot change your personal personality in this server until an administrator runs `/personality all off`.', flags: MessageFlags.Ephemeral });
        return;
      }
      const value = interaction.options.getString('personality', true).trim();
      dataStore.setUserPersonality(userId, value);
      await interaction.reply({ content: '🧠 **Personality saved permanently.** It will be used automatically in your future chats.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'view') {
      if (guildId) {
        const serverValue = guildPersonality.getPersonality(guildId);
        if (serverValue) {
          await interaction.reply({ content: `🧠 **Server-wide personality:**\n${serverValue}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      const value = dataStore.getUserPersonality(userId);
      await interaction.reply({ content: value ? `🧠 **Your personality:**\n${value}` : '🧠 You have no custom personality saved.', flags: MessageFlags.Ephemeral });
      return;
    }

    const removed = dataStore.removeUserPersonality(userId);
    await interaction.reply({ content: removed ? '🧠 **Your saved personality was reset.**' : '🧠 You did not have a saved personality.', flags: MessageFlags.Ephemeral });
  },
};
