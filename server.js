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

// ===== 管理画面 → Discord返信API =====
app.post("/api/tickets/:id/reply", express.json(), async (req, res) => {
  try {
    const ticketId = req.params.id;
    const content = req.body?.content?.trim();

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "メッセージが空です"
      });
    }

    // Supabaseからチケットを取得
    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      console.error("Ticket lookup error:", error);
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    if (!ticket.channel_id) {
      return res.status(400).json({
        ok: false,
        error: "DiscordチャンネルIDがありません"
      });
    }

    // Discordのチケットへ送信
    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "送信先チャンネルが見つかりません"
      });
    }

    const sent = await channel.send(content);

    // 送信内容もmessagesへ保存
    const { error: messageError } = await supabase
      .from("messages")
      .insert({
        ticket_id: ticket.id,
        external_message_id: sent.id,
        sender: "admin",
        sender_name: "管理者",
        content: content
      });

    if (messageError) {
      console.error("Message DB error:", messageError);
    }

    return res.json({
      ok: true,
      messageId: sent.id
    });

  } catch (error) {
    console.error("Admin reply error:", error);

    return res.status(500).json({
      ok: false,
      error: "送信に失敗しました"
    });
  }
});

// ===== OpenAI 接続テスト =====
app.get("/api/ai-test", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        input: "「AI接続成功」とだけ返してください。"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI test error:", data);
      return res.status(500).json({
        ok: false,
        error: data
      });
    }

    return res.json({
      ok: true,
      reply: data.output_text
    });

  } catch (error) {
    console.error("AI test error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
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
// ===== 入金確認 → 作業開始 =====
app.post("/api/tickets/:id/payment-confirmed", async (req, res) => {
  try {
    const ticketId = req.params.id;

    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルが見つかりません"
      });
    }

    const text =
      "✅ 入金を確認しました。ありがとうございます。\n" +
      "これより作業を開始します。";

    const sent = await channel.send(text);

    const { error: updateError } = await supabase
      .from("tickets")
      .update({
        status: "working",
        updated_at: new Date().toISOString()
      })
      .eq("id", ticketId);

    if (updateError) throw updateError;

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      external_message_id: sent.id,
      sender: "admin",
      sender_name: "管理者",
      content: text
    });

    return res.json({ ok: true });

  } catch (error) {
    console.error("Payment confirmed error:", error);

    return res.status(500).json({
      ok: false,
      error: "入金確認に失敗しました"
    });
  }
});
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
    .select("id, ai_enabled, request_details, intake_complete")
    .eq("channel_id", message.channel.id)
    .maybeSingle();

  if (error) {
    console.error("Ticket lookup error:", error);
    return;
  }

  if (!ticket) return;
// ===== 登録プランを取得 =====
const { data: activePlans, error: plansError } = await supabase
  .from("plans")
  .select("*")
  .eq("active", true)
  .order("created_at", { ascending: true });

if (plansError) {
  console.error("Plans lookup error:", plansError);
}

console.log("[ACTIVE PLANS]", activePlans);
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
  // ===== AI 自動受付 =====
try {
  console.log("[AI DEBUG]", { ticketId: ticket.id, ai_enabled: ticket.ai_enabled });
  if (!ticket.ai_enabled) return;
  console.log("[AI DEBUG] 履歴取得開始");

  // このチケットの過去メッセージを取得
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("sender, sender_name, content")
    .eq("ticket_id", ticket.id)
    .order("created_at", { ascending: true })
    .limit(20);

  if (historyError) {
    console.error("History error:", historyError);
    return;
  }
  console.log("[AI DEBUG] 履歴取得成功", history?.length);
  const conversation = (history || []).map((m) => {
  const isStaff =
    m.sender === "bot" ||
    m.sender === "admin" ||
    m.sender_name === "AI受付" ||
    m.sender_name === "管理者";

  const role = isStaff ? "受付スタッフ" : "お客様";
  return `${role}: ${m.content}`;
}).join("\n");
  // ===== 依頼情報をAIで抽出 =====
try {
  const extractResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: `
以下は「妖怪ウォッチ ぷにぷに」の代行受付の会話です。

${conversation}

現在保存されている情報:
${JSON.stringify(ticket.request_details || {})}

会話から確実に分かる情報だけを抽出してください。

JSONだけを返してください。
説明文やマークダウンは付けないでください。

形式:
{
  "service": null,
  "target": null,
  "deadline": null
}

service:
依頼の種類。例: スコアタ、イベント周回、Yポイントなど。

target:
具体的な希望内容。例: 100億。

deadline:
希望期限。例: 今日中、明日まで。

分からない項目はnullにしてください。
すでに保存されている情報は、会話で変更されていない限り維持してください。
`
    })
  });

  const extractData = await extractResponse.json();

  const extractText = extractData.output
    ?.flatMap(item => item.content || [])
    ?.find(item => item.type === "output_text")
    ?.text
    ?.trim();

  if (extractResponse.ok && extractText) {
    try {
      const extracted = JSON.parse(extractText);

      const oldDetails = ticket.request_details || {};

      const newDetails = {
        service: extracted.service ?? oldDetails.service ?? null,
        target: extracted.target ?? oldDetails.target ?? null,
        deadline: extracted.deadline ?? oldDetails.deadline ?? null
      };

    const basicInfoComplete = Boolean(
  newDetails.service &&
  newDetails.target &&
  newDetails.deadline
);

const noMoreRequests =
  /特にない|特になし|ないです|ありません|大丈夫です|ないよ|なし/i.test(
    message.content
  );

const complete = basicInfoComplete && noMoreRequests;

      const { error: updateError } = await supabase
        .from("tickets")
        .update({
          request_details: newDetails,
          intake_complete: complete
        })
        .eq("id", ticket.id);

      if (updateError) {
        console.error("Intake update error:", updateError);
      } else {
        console.log("[INTAKE SAVED]", newDetails, "complete:", complete);

        // この後の受付AIにも最新情報を使わせる
        ticket.request_details = newDetails;
        ticket.intake_complete = complete;
        
        if (complete) {
  // 登録済みプランを取得
  const { data: plans, error: plansError } = await supabase
    .from("plans")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (plansError) {
    console.error("Plan fetch error:", plansError);
  }

  let finalMessage;

  if (plans && plans.length > 0) {
    const planText = plans.map((plan, index) => {
      return `${index + 1}. ${plan.name}\n${plan.description || ""}`;
    }).join("\n\n");

    finalMessage =
      "ありがとうございます！依頼内容を確認しました。\n\n" +
      "ご希望のプランを選んでください👇\n\n" +
      planText +
      "\n\n希望するプラン名、または番号を送ってください。";
  } else {
    finalMessage =
      "ありがとうございます！依頼内容を確認しました。\n" +
      "スタッフが料金を確認しますので、少々お待ちください。";
  }

  await message.reply(finalMessage);

  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    external_message_id: null,
    sender: "bot",
    sender_name: "AI受付",
    content: finalMessage
  });

  console.log("[PLAN SELECTION START]", ticket.id);
          // ===== 受付完了 → 料金確認待ち =====
const { error: waitingPriceError } = await supabase
  .from("tickets")
  .update({
    status: "waiting_price",
    updated_at: new Date().toISOString()
  })
  .eq("id", ticket.id);

if (waitingPriceError) {
  console.error("[WAITING PRICE ERROR]", waitingPriceError);
} else {
  console.log("[WAITING PRICE]", ticket.id);
}
  return;
}
      }

    } catch (parseError) {
      console.error("Intake JSON parse error:", extractText);
    }
  } else {
    console.error("Intake extraction error:", extractData);
  }

} catch (extractError) {
  console.error("Intake extraction failed:", extractError);
}
  
  console.log("[AI DEBUG] OpenAI送信開始");
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: `
あなたは「妖怪ウォッチ ぷにぷに」の代行受付を担当するAIスタッフです。
このサービスでは、ぷにぷに以外のゲームは基本的に扱いません。

お客様との会話:
${conversation}

現在までに確定・保存されている依頼情報:
${JSON.stringify(ticket.request_details || {})}

現在登録されている代行プラン:
${JSON.stringify(activePlans || [])}

重要:
お客様の依頼内容と上の登録プランを照らし合わせてください。
登録プランに該当する場合は、そのプラン名と説明内容を理解したうえで受付を進めてください。
登録されていない料金や条件を勝手に作らないでください。
重要:
上の「依頼情報」と「お客様との会話」ですでに分かっている内容は絶対に質問し直さないでください。
目標スコア・期限などが既に書かれている場合は、その情報を理解したうえで次に不足している情報だけを1つ質問してください。

【役割】
お客様が希望する「ぷにぷに」の代行内容を、自然な会話で確認してください。
すでに会話の中で分かっている情報は絶対に聞き直さず、
不足している情報だけを1つずつ確認してください。

【重要】
・「ゲーム名は何ですか？」とは聞かない。ゲームは妖怪ウォッチ ぷにぷにで確定している
・「スコアタ代行」と言われた場合、まず具体的な希望内容を確認する
・お客様が答えた内容を踏まえて次の質問をする
・一度に大量の質問を並べない
・同じ質問を繰り返さない
・必要以上に長い説明をしない
・スコアタ代行では、使用キャラ・編成・パーティーなどの指定をこちらから質問しない
・「目標スコア」と「期限」が確認できたら、最後に「ほかに何か希望や、事前に伝えておきたいことはありますか？」と1回だけ確認する
・お客様が「特にない」「ないです」などと答えたら、それ以上質問を増やさず受付確認へ進む
・お客様への最終確認が終わった後、利用可能なプランが設定されている場合は、そのプランだけを提示して選んでもらう
・存在しないプランや料金をAIが勝手に作らない
・プランがまだ設定されていない場合は、勝手に提案せず「内容を確認しました。スタッフが料金を確認しますので、少々お待ちください。」と案内する
・お客様がプランを選択したら、それ以上受付を進めずスタッフの料金確認を待つ

【会話の進め方】
1. 何の代行を希望しているか確認
2. その代行に必要な条件・希望を確認
3. 希望期限が必要な場合だけ確認
4. 必要情報が揃ったら「内容を確認しました。スタッフが料金を確認します。」と案内する
【受付完了の判定】
・依頼内容、必要条件、期限がすでに分かっている場合は、それ以上質問しない
・「ほかに希望はありますか？」「事前に伝えたいことはありますか？」などの任意確認はしない
・必要情報が揃った時点で、必ず「内容を確認しました。スタッフが料金を確認しますので、少々お待ちください。」と案内して受付を終了する
・登録プランが依頼内容に一致する場合も、不要な追加質問をせず受付完了へ進める
・登録プランが1つしかなく、そのプランが依頼内容に一致する場合は「このプランでよろしいですか？」と確認しない
・一致するプランが1つに決まる場合は、そのプランを自動的に選択して受付完了へ進む
・プラン選択後は「内容を確認しました。スタッフが料金を確認しますので、少々お待ちください。」とだけ案内する
【スタッフ対応に切り替えるもの】
・料金の最終決定
・値下げ交渉
・返金
・クレーム
・トラブル
・特殊な依頼
・AIでは判断できない内容

これらの場合は勝手に回答せず、
「こちらはスタッフが確認しますので、少々お待ちください。」
と案内してください。

【セキュリティ】
Discord上でパスワード、認証コード、メールの確認コードなどの秘密情報を要求しないでください。
ログイン情報が必要な場合でも、ここでは要求せずスタッフ確認に回してください。

【返信スタイル】
・日本語
・親しみやすい
・簡潔
・基本1回につき質問は1つ
・絵文字は多用しない
・返信文だけを出力する
`
    })
  });

  const aiData = await aiResponse.json();
  console.log("[AI DEBUG] OpenAI応答", aiResponse.status);

  if (!aiResponse.ok) {
    console.error("OpenAI error:", aiData);
    return;
  }

  const reply = aiData.output
  ?.flatMap(item => item.content || [])
  ?.find(item => item.type === "output_text")
  ?.text
  ?.trim();
  console.log("[AI DEBUG] AI返信内容", reply);

  if (!reply) return;

  // DiscordへAI返信
  const sent = await message.channel.send(reply);

  // AI返信もDBへ保存
  const { error: aiMessageError } = await supabase
    .from("messages")
    .insert({
      ticket_id: ticket.id,
      external_message_id: sent.id,
      sender: "bot",
      sender_name: "AI受付",
      content: reply
    });

  if (aiMessageError) {
    console.error("AI message DB error:", aiMessageError);
  }

} catch (aiError) {
  console.error("AI auto reply error:", aiError);
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

console.log("[DISCORD LOGIN] ログイン開始");

client.login(process.env.DISCORD_TOKEN)
  .then(() => {
    console.log("[DISCORD LOGIN SUCCESS]");
  })
  .catch(error => {
    console.error("[DISCORD LOGIN ERROR]", error);
  });

client.on("error", error => {
  console.error("[DISCORD CLIENT ERROR]", error);
});

client.on("shardError", error => {
  console.error("[DISCORD SHARD ERROR]", error);
});
// ===== DaikoHub 管理画面 API =====
// ===== プランAPI =====

// プラン一覧取得
app.get("/api/plans", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("plans")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error("GET plans error:", error);
    res.status(500).json({ error: error.message });
  }
});

// プラン追加
app.post("/api/plans", express.json(), async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "プラン名が必要です" });
    }

    const { data, error } = await supabase
      .from("plans")
      .insert({
        service: "スコアタ代行",
        name: name.trim(),
        description: description?.trim() || ""
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, plan: data });
  } catch (error) {
    console.error("POST plans error:", error);
    res.status(500).json({ error: error.message });
  }
});
// ===== 料金確定 → Discordへ送信 =====
app.post("/api/tickets/:id/set-price", async (req, res) => {
  try {
    const ticketId = req.params.id;
    const price = Number(req.body?.price);

    if (!Number.isInteger(price) || price <= 0) {
      return res.status(400).json({
        ok: false,
        error: "正しい料金を入力してください"
      });
    }

    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    if (!ticket.channel_id) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルがありません"
      });
    }

    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルが見つかりません"
      });
    }

    const text =
      `料金が確定しました。\n\n` +
      `💴 **${price.toLocaleString()}円**\n\n` +
      `お支払いの準備ができましたらお知らせください。`;

    const sent = await channel.send(text);

    await supabase
      .from("tickets")
      .update({
        price,
        status: "waiting_payment",
        updated_at: new Date().toISOString()
      })
      .eq("id", ticketId);

    await supabase
      .from("messages")
      .insert({
        ticket_id: ticketId,
        external_message_id: sent.id,
        sender: "admin",
        sender_name: "管理者",
        content: text
      });

    return res.json({
      ok: true,
      price
    });

  } catch (error) {
    console.error("Set price error:", error);

    return res.status(500).json({
      ok: false,
      error: "料金確定に失敗しました"
    });
  }
});
// ===== 支払い案内 → Discordへ送信 =====
app.post("/api/tickets/:id/payment-guide", async (req, res) => {
  try {
    const ticketId = req.params.id;
    const paymentUrl = req.body?.paymentUrl?.trim();

    if (!paymentUrl) {
      return res.status(400).json({
        ok: false,
        error: "支払いURLを入力してください"
      });
    }

    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルが見つかりません"
      });
    }

    const priceText = ticket.price
      ? `料金：${Number(ticket.price).toLocaleString()}円\n\n`
      : "";

    const text =
      `お支払いはこちらからお願いします。\n\n` +
      priceText +
      `${paymentUrl}\n\n` +
      `お支払いが完了しましたら、このチャンネルでお知らせください。`;

    const sent = await channel.send(text);

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      external_message_id: sent.id,
      sender: "admin",
      sender_name: "管理者",
      content: text
    });

    return res.json({ ok: true });

  } catch (error) {
    console.error("Payment guide error:", error);

    return res.status(500).json({
      ok: false,
      error: "支払い案内の送信に失敗しました"
    });
  }
});
// チケット一覧
app.get("/api/tickets", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error("GET tickets error:", error);
    res.status(500).json({ error: error.message });
  }
});

// チケットごとのメッセージ一覧
app.get("/api/tickets/:id/messages", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("ticket_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error("GET messages error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ステータス変更
app.patch("/api/tickets/:id/status", async (req, res) => {
  try {
    const { status } = req.body;

    const allowed = [
      "new",
      "ai_intake",
      "waiting_payment",
      "working",
      "waiting",
      "completed"
    ];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const { data, error } = await supabase
      .from("tickets")
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error("PATCH status error:", error);
    res.status(500).json({ error: error.message });
  }
});
// ===== 入金確認 → 作業開始 =====
app.post("/api/tickets/:id/payment-confirmed-v2", async (req, res) => {
  try {
    const ticketId = req.params.id;

    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルが見つかりません"
      });
    }

    const text =
      "✅ 入金を確認しました。ありがとうございます。\n" +
      "これより作業を開始します。";

    const sent = await channel.send(text);

    const { error: updateError } = await supabase
      .from("tickets")
      .update({
        status: "working",
        updated_at: new Date().toISOString()
      })
      .eq("id", ticketId);

    if (updateError) throw updateError;

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      external_message_id: sent.id,
      sender: "admin",
      sender_name: "管理者",
      content: text
    });

    return res.json({ ok: true });

  } catch (error) {
    console.error("Payment confirmed V2 error:", error);

    return res.status(500).json({
      ok: false,
      error: "入金確認に失敗しました"
    });
  }
});
// ===== 作業完了 =====
app.post("/api/tickets/:id/complete-job", async (req, res) => {
  try {
    const ticketId = req.params.id;

    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        ok: false,
        error: "チケットが見つかりません"
      });
    }

    const channel = await client.channels.fetch(ticket.channel_id);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        ok: false,
        error: "Discordチャンネルが見つかりません"
      });
    }

    const text =
      "✅ 作業が完了しました！\n" +
      "ご依頼ありがとうございました。";

    const sent = await channel.send(text);

    const { error: updateError } = await supabase
      .from("tickets")
      .update({
        status: "completed",
        updated_at: new Date().toISOString()
      })
      .eq("id", ticketId);

    if (updateError) throw updateError;

    await supabase.from("messages").insert({
      ticket_id: ticket.id,
      external_message_id: sent.id,
      sender: "admin",
      sender_name: "管理者",
      content: text
    });

    return res.json({ ok: true });

  } catch (error) {
    console.error("Complete job error:", error);

    return res.status(500).json({
      ok: false,
      error: "作業完了処理に失敗しました"
    });
  }
});
// ===== 売上集計 =====
app.get("/api/sales", async (req, res) => {
  try {
    const { data: tickets, error } = await supabase
      .from("tickets")
      .select("price, status, updated_at")
      .eq("status", "completed");

    if (error) throw error;

    const now = new Date();

    let today = 0;
    let month = 0;
    let total = 0;

    for (const ticket of tickets || []) {
      const price = Number(ticket.price) || 0;
      const date = new Date(ticket.updated_at);

      total += price;

      if (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth()
      ) {
        month += price;
      }

      if (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
      ) {
        today += price;
      }
    }

    return res.json({
      ok: true,
      today,
      month,
      total
    });

  } catch (error) {
    console.error("Sales error:", error);

    return res.status(500).json({
      ok: false,
      error: "売上の取得に失敗しました"
    });
  }
});
// 管理画面
app.get("/admin", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DaikoHub</title>

<style>
*{box-sizing:border-box}
body{
 margin:0;
 background:#0b0d12;
 color:#fff;
 font-family:Arial,sans-serif;
}
header{
 padding:18px 22px;
 border-bottom:1px solid #262a35;
 display:flex;
 justify-content:space-between;
 align-items:center;
}
.logo{font-size:23px;font-weight:800}
.live{color:#52e69a;font-size:13px}
main{
 display:grid;
 grid-template-columns:360px 1fr;
 height:calc(100vh - 65px);
}
.sidebar{
 border-right:1px solid #262a35;
 overflow:auto;
}
.title{
 padding:18px;
 font-weight:bold;
 color:#aaa;
}
.ticket{
 padding:16px 18px;
 border-bottom:1px solid #20242e;
 cursor:pointer;
}
.ticket:hover{background:#151923}
.ticket.active{background:#191e2a}
.user{font-weight:bold;margin-bottom:7px}
.meta{font-size:12px;color:#999}
.badge{
 display:inline-block;
 padding:4px 8px;
 border-radius:20px;
 background:#272d3a;
 margin-top:8px;
 font-size:11px;
}
.content{
 padding:24px;
 overflow:auto;
}
.empty{
 color:#777;
 text-align:center;
 margin-top:120px;
}
.top{
 display:flex;
 justify-content:space-between;
 gap:20px;
 align-items:center;
 border-bottom:1px solid #262a35;
 padding-bottom:18px;
}
.messages{margin-top:20px}
.message{
 background:#171b24;
 padding:12px 15px;
 border-radius:12px;
 margin:8px 0;
 max-width:700px;
}
.message.bot{border-left:3px solid #8b5cf6}
.sender{font-size:11px;color:#888;margin-bottom:5px}
select{
 background:#171b24;
 color:white;
 border:1px solid #343a49;
 padding:10px;
 border-radius:8px;
}
.stats{
 display:flex;
 gap:10px;
 padding:12px 18px;
 border-bottom:1px solid #262a35;
}
.stat{
 background:#151923;
 padding:9px 12px;
 border-radius:10px;
 font-size:12px;
}
@media(max-width:700px){
 main{grid-template-columns:1fr}
 .sidebar{border-right:0}
 .content{display:none}
 body.open .sidebar{display:none}
 body.open .content{display:block}
}
</style>
</head>

<body>

<header>
 <div class="logo">⚡ DaikoHub</div>
 <div class="live">● LIVE</div>
</header>
<div id="salesSummary" style="
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:10px;
  padding:12px 18px;
  background:#0b0d12;
">
  <div class="stat">
    今日の売上
    <b id="salesToday">¥0</b>
  </div>

  <div class="stat">
    今月の売上
    <b id="salesMonth">¥0</b>
  </div>

  <div class="stat">
    累計売上
    <b id="salesTotal">¥0</b>
  </div>
</div>
<main>
 <section class="sidebar">
   <div class="stats">
     <div class="stat">依頼 <b id="count">0</b></div>
     <div class="stat">作業中 <b id="working">0</b></div>
   </div>
   <div class="title">受信トレイ</div>
   <div id="tickets">読み込み中...</div>
   
   <button class="settings-btn" onclick="showPlanSettings()">
     ⚙️ プラン設定
</button>
 </section>

 <section class="content" id="content">
   <div class="empty">チケットを選択してください</div>
 </section>
</main>

<script>
let selectedId = null;
let previousIds = new Set();
function showPlanSettings() {
  selectedId = null;

  document.getElementById("content").innerHTML = \`
    <h2>⚙️ プラン設定</h2>

    <div style="margin-top:20px;">
      <h3>スコアタ代行</h3>

      <label>プラン名</label><br>
      <input
        id="planName"
        type="text"
        placeholder="例：通常プラン"
        style="width:100%;padding:10px;margin:8px 0 15px;"
      >

      <label>プラン説明</label><br>
      <textarea
        id="planDescription"
        placeholder="例：通常のスコアタ代行"
        style="width:100%;padding:10px;min-height:80px;margin:8px 0 15px;"
      ></textarea>

      <button onclick="addPlan()">
        ＋ プランを追加
      </button>

      <div id="planList" style="margin-top:20px;">
        まだプランは登録されていません
      </div>
    </div>
  \`;
  loadPlans();
}
async function addPlan() {
  const name = document.getElementById("planName").value.trim();
  const description = document.getElementById("planDescription").value.trim();

  if (!name) {
    alert("プラン名を入力してください");
    return;
  }

  try {
    const res = await fetch("/api/plans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        description
      })
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || "プランの保存に失敗しました");
    }

    document.getElementById("planName").value = "";
    document.getElementById("planDescription").value = "";

    await loadPlans();

  } catch (error) {
    console.error("addPlan error:", error);
    alert("プランの保存に失敗しました: " + error.message);
  }
}

async function loadPlans() {
  try {
    const res = await fetch("/api/plans");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "プランの読み込みに失敗しました");
    }

    const list = document.getElementById("planList");
    if (!list) return;

    if (!data.length) {
      list.innerHTML = "まだプランは登録されていません";
      return;
    }

    list.innerHTML = data.map(plan =>
  '<div style="padding:12px;border:1px solid #333;border-radius:8px;margin-bottom:10px;">' +
    '<b>' + esc(plan.name) + '</b>' +
    '<div style="margin-top:5px;">' + esc(plan.description || "") + '</div>' +
  '</div>'
).join("");

  } catch (error) {
    console.error("loadPlans error:", error);

    const list = document.getElementById("planList");
    if (list) {
      list.innerHTML = "プランの読み込みに失敗しました";
    }
  }
}
let plans = JSON.parse(localStorage.getItem("daikohub_plans") || "[]");

const statusNames = {
 new:"🟢 新規",
 ai_intake:"🤖 AI受付中",
 waiting_price: "💴 料金確認待ち",
 waiting_payment:"💰 入金待ち",
 working:"🔵 作業中",
 waiting:"🟡 要確認",
 completed:"✅ 完了"
};

function esc(value){
 return String(value ?? "")
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;")
  .replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");
}
async function loadSales() {
  try {
    const response = await fetch("/api/sales");
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "売上取得に失敗しました");
    }

    document.getElementById("salesToday").textContent =
      "¥" + Number(data.today || 0).toLocaleString();

    document.getElementById("salesMonth").textContent =
      "¥" + Number(data.month || 0).toLocaleString();

    document.getElementById("salesTotal").textContent =
      "¥" + Number(data.total || 0).toLocaleString();

  } catch (error) {
    console.error("loadSales error:", error);
  }
}
async function loadTickets(){
 try{
  const r = await fetch("/api/tickets");
  if(!r.ok) throw new Error("HTTP " + r.status);

  const data = await r.json();

  document.getElementById("count").textContent = data.length;
  document.getElementById("working").textContent =
    data.filter(x=>x.status==="working").length;

  const box = document.getElementById("tickets");

  if(!data.length){
    box.innerHTML='<div class="empty">まだ依頼がありません</div>';
    return;
  }

  box.innerHTML=data.map(t=>\`
    <div class="ticket \${String(t.id)===String(selectedId)?"active":""}"
         onclick="openTicket('\${t.id}')">
      <div class="user">
       \${t.platform==="discord"?"💬":"📩"}
       \${esc(t.username || "Unknown")}
      </div>

      <div class="meta">
       \${esc(t.service || "依頼内容を確認中")}
      </div>

      <span class="badge">
       \${statusNames[t.status] || esc(t.status)}
      </span>
    </div>
  \`).join("");

  const currentIds = new Set(data.map(x=>String(x.id)));

  if(previousIds.size){
    const added = [...currentIds].filter(id=>!previousIds.has(id));
    if(added.length && "Notification" in window &&
       Notification.permission==="granted"){
      new Notification("DaikoHub",{
       body:"新しいチケットが開かれました"
      });
    }
  }

  previousIds=currentIds;

 }catch(e){
  console.error(e);
 }
}

async function openTicket(id){
 selectedId=id;
 document.body.classList.add("open");

 const [tr,mr]=await Promise.all([
   fetch("/api/tickets"),
   fetch("/api/tickets/"+id+"/messages")
 ]);

 const tickets=await tr.json();
 const messages=await mr.json();
 const t=tickets.find(x=>String(x.id)===String(id));

 if(!t) return;

 document.getElementById("content").innerHTML=\`
  <div class="top">
   <div>
    <h2>\${esc(t.username || "Unknown")}</h2>
    <div class="meta">
     \${esc(t.platform)} ・ Ticket #\${esc(t.id)}
    </div>
   </div>

   <select onchange="changeStatus('\${t.id}',this.value)">
    \${Object.entries(statusNames).map(([key,name])=>
      \`<option value="\${key}" \${t.status===key?"selected":""}>
       \${name}
      </option>\`
    ).join("")}
   </select>
  </div>

  <div class="messages">
   <h3>会話</h3>

   \${messages.length ? messages.map(m=>\`
     <div class="message \${m.sender==="bot"?"bot":""}">
       <div class="sender">\${esc(m.sender_name || m.sender)}</div>
       <div>\${esc(m.content)}</div>
     </div>
   \`).join("") :
   '<div class="empty">まだメッセージがありません</div>'}
  </div>
  <div style="margin-top:20px;padding:15px;background:#151923;border-radius:10px;">
  <div style="font-weight:bold;margin-bottom:10px;">💴 料金設定</div>

  <div style="display:flex;gap:8px;">
    <input
      id="priceInput"
      type="number"
      min="1"
      placeholder="例：1000"
      value="\${t.price || ""}"
      style="flex:1;padding:10px;border-radius:8px;border:1px solid #343a49;"
    >

    <button onclick="setPrice('\${t.id}')">
      料金確定
    </button>
  </div>
</div>
<div style="margin-top:15px;padding:15px;background:#151923;border-radius:10px;">
  <div style="font-weight:bold;margin-bottom:10px;">💳 支払い案内</div>

  <input
    id="paymentUrlInput"
    type="text"
    placeholder="PayPayなどの支払いURLを貼り付け"
    style="width:100%;padding:10px;border-radius:8px;border:1px solid #343a49;margin-bottom:8px;"
  >

  <button onclick="sendPaymentGuide('\${t.id}')">
    支払い案内を送信
  </button>
  
  <button
  onclick="confirmPayment('\${t.id}')"
  style="margin-top:10px;padding:10px 15px;"
>
  ✅ 入金確認
</button>

<button
  onclick="completeJob('\${t.id}')"
  style="margin-top:10px;padding:10px 15px;"
>
  ✅ 作業完了
</button>
</div>
     <div class="reply-box">
        <input
          id="replyInput"
          type="text"
          placeholder="Discordへ返信..."
          onkeydown="if(event.key==='Enter') sendReply(selectedId)"
        >
        <button
          id="replyButton"
          onclick="sendReply(selectedId)"
        >
          送信
        </button>
      </div>
 \`;

 loadTickets();
}

async function changeStatus(id,status){
 await fetch("/api/tickets/"+id+"/status",{
  method:"PATCH",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({status})
 });

 await loadTickets();
}

if("Notification" in window &&
   Notification.permission==="default"){
 Notification.requestPermission();
}

loadTickets();
loadSales();

setInterval(() => {
  loadTickets();
  loadSales();

  const active = document.activeElement;
  const isTyping =
  active &&
  (
    active.id === "priceInput" ||
    active.id === "replyInput" ||
    active.id === "paymentUrlInput"
  );
  if (selectedId && !isTyping) {
    openTicket(selectedId);
  }
}, 3000);
async function setPrice(ticketId) {
  const input = document.getElementById("priceInput");
  const price = Number(input.value);

  if (!Number.isInteger(price) || price <= 0) {
    alert("正しい料金を入力してください");
    return;
  }

  if (!confirm(price.toLocaleString() + "円で料金を確定してDiscordへ送信しますか？")) {
    return;
  }

  try {
    const response = await fetch("/api/tickets/" + ticketId + "/set-price", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ price })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "料金確定に失敗しました");
    }

    alert(price.toLocaleString() + "円で料金を確定しました");

    await loadTickets();
    await openTicket(ticketId);

  } catch (error) {
    console.error("setPrice error:", error);
    alert("料金確定に失敗しました: " + error.message);
  }
}
async function sendPaymentGuide(ticketId) {
  const input = document.getElementById("paymentUrlInput");
  const paymentUrl = input.value.trim();

  if (!paymentUrl) {
    alert("支払いURLを入力してください");
    return;
  }

  if (!confirm("この支払い案内をDiscordへ送信しますか？")) {
    return;
  }

  try {
    const response = await fetch(
      "/api/tickets/" + ticketId + "/payment-guide",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ paymentUrl })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "送信に失敗しました");
    }

    alert("支払い案内をDiscordへ送信しました");
    input.value = "";

    await openTicket(ticketId);

  } catch (error) {
    console.error("sendPaymentGuide error:", error);
    alert("送信に失敗しました: " + error.message);
  }
}
// ↓ここに追加
async function confirmPayment(ticketId) {
  if (!confirm("入金確認済みにして、作業を開始しますか？")) {
    return;
  }

  try {
    const response = await fetch(
      "/api/tickets/" + ticketId + "/payment-confirmed-v2",
      {
        method: "POST"
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "入金確認に失敗しました");
    }

    alert("入金を確認しました。作業中に変更しました！");

    await loadTickets();
    await openTicket(ticketId);

  } catch (error) {
    console.error("confirmPayment error:", error);
    alert("入金確認に失敗しました: " + error.message);
  }
}
async function completeJob(ticketId) {
  if (!confirm("この依頼を作業完了にしますか？")) {
    return;
  }

  try {
    const response = await fetch(
      "/api/tickets/" + ticketId + "/complete-job",
      {
        method: "POST"
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "作業完了に失敗しました");
    }

    alert("作業完了に変更しました！");

    await loadTickets();
    await openTicket(ticketId);

  } catch (error) {
    console.error("completeJob error:", error);
    alert("作業完了に失敗しました: " + error.message);
  }
}
async function sendPaymentGuide(ticketId) {
  const input = document.getElementById("paymentUrlInput");
  const paymentUrl = input.value.trim();

  if (!paymentUrl) {
    alert("支払いURLを入力してください");
    return;
  }

  if (!confirm("この支払い案内をDiscordへ送信しますか？")) {
    return;
  }

  try {
    const response = await fetch(
      "/api/tickets/" + ticketId + "/payment-guide",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ paymentUrl })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "送信に失敗しました");
    }

    alert("支払い案内をDiscordへ送信しました");
    input.value = "";

    await openTicket(ticketId);

  } catch (error) {
    console.error("sendPaymentGuide error:", error);
    alert("送信に失敗しました: " + error.message);
  }
}
async function sendReply(ticketId) {
  const input = document.getElementById("replyInput");
  const button = document.getElementById("replyButton");
  const content = input.value.trim();

  if (!content) return;

  button.disabled = true;
  button.textContent = "送信中...";

  try {
    const response = await fetch("/api/tickets/" + ticketId + "/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      alert(data.error || "送信に失敗しました");
      return;
    }

    input.value = "";
    await openTicket(ticketId);

  } catch (error) {
    console.error(error);
    alert("送信に失敗しました");
  } finally {
    button.disabled = false;
    button.textContent = "送信";
  }
}

</script>
</body>
</html>
</script>

</body>
</html>
  `);
});
