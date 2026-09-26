import express from "express";
import { createClient } from "@supabase/supabase-js";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from "discord.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Render用
app.get("/", (req, res) => {
  res.send("DaikoHub Bot is running!");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    discord: client.isReady(),
    supabase: !!process.env.SUPABASE_URL
  });
});

app.listen(PORT, () => {
  console.log(`Web server started on ${PORT}`);
});

// Bot起動
client.once("ready", async () => {
  console.log(`Discord Bot ready: ${client.user.tag}`);

  try {
    await client.application.commands.set([
      {
        name: "panel",
        description: "代行受付パネルを設置します"
      }
    ]);

    console.log("/panel command registered");
  } catch (error) {
    console.error("Command registration error:", error);
  }
});

client.on("interactionCreate", async (interaction) => {

  // ========================
  // /panel
  // ========================
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName !== "panel") return;

    if (
      !interaction.member.permissions.has(
        PermissionFlagsBits.Administrator
      )
    ) {
      return interaction.reply({
        content: "このコマンドは管理者専用です。",
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("🎮 ぷにぷに代行受付")
      .setDescription(
        "代行をご希望の方は下のボタンを押してください。\n\n" +
        "あなた専用の受付チャンネルを自動で作成します。"
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("create_ticket")
        .setLabel("🎫 チケットを作成")
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });

    return;
  }

  // ========================
  // チケット作成
  // ========================
  if (
    interaction.isButton() &&
    interaction.customId === "create_ticket"
  ) {

    await interaction.deferReply({
      ephemeral: true
    });

    const guild = interaction.guild;
    const user = interaction.user;

    const existing = guild.channels.cache.find(
      ch => ch.topic === `daikohub:${user.id}`
    );

    if (existing) {
      return interaction.editReply(
        `すでにチケットがあります → ${existing}`
      );
    }

    try {

      const channel = await guild.channels.create({
        name: `依頼-${user.username}`,
        type: ChannelType.GuildText,

        topic: `daikohub:${user.id}`,

        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },

          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          },

          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      });

      // Supabaseへチケット保存
      const { data: ticket, error } = await supabase
        .from("tickets")
        .insert({
          platform: "discord",
          external_user_id: user.id,
          username: user.username,
          channel_id: channel.id,
          status: "受付中",
          ai_enabled: true
        })
        .select()
        .single();

      if (error) {
        console.error("Ticket DB error:", error);
      } else {
        console.log(
          `[NEW TICKET] DB ID ${ticket.id} / ${user.username}`
        );
      }

      const closeRow =
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("🔒 チケットを閉じる")
            .setStyle(ButtonStyle.Danger)
        );

      await channel.send({
        content:
          `ようこそ <@${user.id}> さん！\n\n` +
          "🎮 **ぷにぷに代行受付です。**\n\n" +
          "ここから必要な内容を順番に確認します。\n\n" +
          "まずは、**今回お願いしたい代行内容**を自由に送ってください！",
        components: [closeRow]
      });

      await interaction.editReply(
        `✅ チケットを作成しました → ${channel}`
      );

    } catch (error) {

      console.error("Ticket creation error:", error);

      await interaction.editReply(
        "❌ チケット作成中にエラーが発生しました。"
      );
    }

    return;
  }

  // ========================
  // チケットを閉じる
  // ========================
  if (
    interaction.isButton() &&
    interaction.customId === "close_ticket"
  ) {

    const channel = interaction.channel;

    if (!channel.topic?.startsWith("daikohub:")) {
      return;
    }

    await interaction.reply(
      "🔒 チケットを閉じます..."
    );

    await supabase
      .from("tickets")
      .update({
        status: "完了",
        updated_at: new Date().toISOString()
      })
      .eq("channel_id", channel.id);

    setTimeout(async () => {

      try {
        await channel.delete();
      } catch (error) {
        console.error(error);
      }

    }, 2000);
  }
});

// ========================
// 客からのメッセージ保存
// ========================
client.on("messageCreate", async (message) => {

  if (message.author.bot) return;

  if (
    !message.channel.topic?.startsWith("daikohub:")
  ) {
    return;
  }

  console.log(
    `[TICKET MESSAGE] ${message.author.username}: ${message.content}`
  );

  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("channel_id", message.channel.id)
    .maybeSingle();

  if (error) {
    console.error("Ticket lookup error:", error);
    return;
  }

  if (!ticket) return;

  const { error: messageError } = await supabase
    .from("messages")
    .insert({
      ticket_id: ticket.id,
      external_message_id: message.id,
      sender: "customer",
      sender_name: message.author.username,
      content: message.content
    });

  if (messageError) {
    console.error(
      "Message DB error:",
      messageError
    );
  }
});

// ========================
// 起動チェック
// ========================
if (
  !process.env.DISCORD_TOKEN ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  console.error(
    "Required environment variable is missing."
  );

  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
