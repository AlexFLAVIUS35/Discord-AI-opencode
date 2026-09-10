import {
  Interaction,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import { commands } from '../commands/index.js';
import { handleButton } from './buttonHandler.js';
import { isAuthorized } from '../services/configStore.js';
import * as guildPersonality from '../services/guildPersonalityStore.js';
import * as personalitySplit from '../services/personalitySplitStore.js';

export async function handleInteraction(interaction: Interaction) {
  if (interaction.isButton()) {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({
        content: '🚫 You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.customId.startsWith('personality_split_')) {
      try {
        await handlePersonalitySplitButton(interaction);
      } catch (error) {
        console.error('Error handling personality split button:', error);
      }
      return;
    }

    try {
      await handleButton(interaction);
    } catch (error) {
      console.error('Error handling button:', error);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!isAuthorized(interaction.user.id)) {
      await interaction.reply({
        content: '🚫 You are not authorized to use this bot.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.customId.startsWith('personality_split_modal:')) {
      try {
        await handlePersonalitySplitModal(interaction);
      } catch (error) {
        console.error('Error handling personality split modal:', error);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: '❌ Could not save that personality part. Try submitting it again.',
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch {
          // Interaction already expired or was acknowledged.
        }
      }
      return;
    }
  }

  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`Error handling autocomplete for ${interaction.commandName}:`, error);
        try {
          if (!interaction.responded) {
            await interaction.respond([]);
          }
        } catch {
          // Interaction already expired — nothing to do
        }
      }
    }
    return;
  }
  
  if (!interaction.isChatInputCommand()) return;
  
  if (!isAuthorized(interaction.user.id)) {
    await interaction.reply({
      content: '🚫 You are not authorized to use this bot.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  
  const command = commands.get(interaction.commandName);
  
  if (!command) {
    return;
  }
  
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);
    const content = '❌ An error occurred while executing the command.';
    
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error('Failed to send error response to user:', replyError);
    }
  }
}

async function handlePersonalitySplitButton(interaction: import('discord.js').ButtonInteraction) {
  const [, action, guildId, userId] = interaction.customId.match(/^personality_split_(next|done):([^:]+):([^:]+)$/) ?? [];

  if (!action || !guildId || !userId || userId !== interaction.user.id) {
    await interaction.reply({ content: '❌ This personality setup belongs to someone else.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.guildId || interaction.guildId !== guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Only the administrator who started this setup can use it.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (personalitySplit.getPartCount(guildId, userId) === 0 && action === 'done') {
    await interaction.reply({ content: '❌ Add at least one personality part first.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'next') {
    const modal = new ModalBuilder()
      .setCustomId(`personality_split_modal:${guildId}:${userId}`)
      .setTitle('Add Personality Part');

    const input = new TextInputBuilder()
      .setCustomId('personality_part')
      .setLabel('Personality text')
      .setPlaceholder('Type the next part of the personality...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  const value = personalitySplit.finish(guildId, userId);
  if (!value) {
    await interaction.reply({ content: '❌ This personality setup has expired. Run `/personality all set split:true` again.', flags: MessageFlags.Ephemeral });
    return;
  }

  guildPersonality.set(guildId, value);
  await interaction.update({
    content: '🧠 **Server-wide personality enabled.** Your complete personality has been saved.',
    components: [],
  });
}

async function handlePersonalitySplitModal(interaction: import('discord.js').ModalSubmitInteraction) {
  const [, guildId, userId] = interaction.customId.match(/^personality_split_modal:([^:]+):([^:]+)$/) ?? [];

  if (!guildId || !userId || userId !== interaction.user.id || interaction.guildId !== guildId) {
    await interaction.reply({ content: '❌ This personality setup belongs to someone else.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Only the administrator who started this setup can use it.', flags: MessageFlags.Ephemeral });
    return;
  }

  const part = interaction.fields.getTextInputValue('personality_part');
  const count = personalitySplit.addPart(guildId, userId, part);

  if (count === undefined) {
    await interaction.reply({ content: '❌ This personality setup has expired. Run `/personality all set split:true` again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const nextButton = new ButtonBuilder()
    .setCustomId(`personality_split_next:${guildId}:${userId}`)
    .setLabel('Next Part')
    .setStyle(ButtonStyle.Secondary);
  const doneButton = new ButtonBuilder()
    .setCustomId(`personality_split_done:${guildId}:${userId}`)
    .setLabel('Done')
    .setStyle(ButtonStyle.Success);
  const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(nextButton, doneButton)];
  const content = `🧠 **Split personality setup**\n\nPress **Next Part** to enter another personality part. Press **Done** when finished.\n\nParts: **${count}**`;

  // A modal opened by a button is a message-originated modal. Update that
  // original message instead of trying to edit the modal interaction's
  // message object. This keeps the Next Part / Done buttons alive.
  if (interaction.isFromMessage()) {
    await interaction.update({ content, components });
    return;
  }

  await interaction.reply({ content: `✅ Part **${count}** added. Press **Next Part** for another part or **Done** when finished.`, flags: MessageFlags.Ephemeral });
}
