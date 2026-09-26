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
// ===== DaikoHub 管理画面 API =====

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

<main>
 <section class="sidebar">
   <div class="stats">
     <div class="stat">依頼 <b id="count">0</b></div>
     <div class="stat">作業中 <b id="working">0</b></div>
   </div>
   <div class="title">受信トレイ</div>
   <div id="tickets">読み込み中...</div>
 </section>

 <section class="content" id="content">
   <div class="empty">チケットを選択してください</div>
 </section>
</main>

<script>
let selectedId = null;
let previousIds = new Set();

const statusNames = {
 new:"🟢 新規",
 ai_intake:"🤖 AI受付中",
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
setInterval(()=>{
 loadTickets();
 if(selectedId) openTicket(selectedId);
},3000);
  setInterval(()=>{
    loadTickets();
    if(selectedId) openTicket(selectedId);
  },3000);


// ↓ここに追加
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
