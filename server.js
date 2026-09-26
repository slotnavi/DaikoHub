import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from "discord.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("DaikoHub Bot is running!");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Web server started on ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// --------------------
// Bot起動
// --------------------
client.once("ready", () => {
  console.log(`Discord Bot ready: ${client.user.tag}`);
});

// --------------------
// /panel コマンド
// --------------------
client.on("interactionCreate", async (interaction) => {

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
        "代行をご希望の方は、下のボタンを押してください。\n\n" +
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

  // --------------------
  // チケット作成
  // --------------------
  if (
    interaction.isButton() &&
    interaction.customId === "create_ticket"
  ) {
    const guild = interaction.guild;
    const user = interaction.user;

    const existing = guild.channels.cache.find(
      ch => ch.topic === `daikohub:${user.id}`
    );

    if (existing) {
      return interaction.reply({
        content: `すでにチケットがあります → ${existing}`,
        ephemeral: true
      });
    }

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
            PermissionFlagsBits.ReadMessageHistory
          ]
        }
      ]
    });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("🔒 チケットを閉じる")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content:
        `ようこそ <@${user.id}> さん！\n\n` +
        "🎮 **ぷにぷに代行受付です。**\n\n" +
        "ここから必要な内容を順番に確認します。\n" +
        "まずは、**今回お願いしたい代行内容**を自由に送ってください！",
      components: [closeRow]
    });

    await interaction.reply({
      content: `✅ チケットを作成しました → ${channel}`,
      ephemeral: true
    });

    console.log(
      `[NEW TICKET] ${user.username} (${user.id})`
    );

    return;
  }

  // --------------------
  // チケットを閉じる
  // --------------------
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

    setTimeout(async () => {
      try {
        await channel.delete();
      } catch (error) {
        console.error(error);
      }
    }, 2000);
  }
});

// --------------------
// チケット内の会話取得
// 後でここをAI＋管理画面に接続する
// --------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!message.channel.topic?.startsWith("daikohub:")) {
    return;
  }

  console.log(
    `[TICKET MESSAGE] ${message.author.username}: ${message.content}`
  );
});

// --------------------
// Slash Command登録
// --------------------
client.on("ready", async () => {
  try {
    await client.application.commands.set([
      {
        name: "panel",
        description: "代行受付パネルを設置します"
      }
    ]);

    console.log("/panel command registered");
  } catch (error) {
    console.error(error);
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is missing");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
