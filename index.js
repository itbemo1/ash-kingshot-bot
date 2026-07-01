import "dotenv/config";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const dbPath = process.env.DB_PATH || "./ash-data.json";

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
  process.exit(1);
}

const LOGIN_URL = "https://kingshot-giftcode.centurygame.com/api/player";
const REDEEM_URL = "https://kingshot-giftcode.centurygame.com/api/gift_code";
const KS_SECRET = "mN4!pQs6JrYwV9";

function loadDb() {
  if (!fs.existsSync(dbPath)) {
    return { mode: "approval", members: {}, usedCodes: [] };
  }

  try {
    const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    return {
      mode: data.mode || "approval",
      members: data.members || {},
      usedCodes: data.usedCodes || []
    };
  } catch {
    return { mode: "approval", members: {}, usedCodes: [] };
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

const db = loadDb();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function signPayload(data) {
  const sortedKeys = Object.keys(data).sort();

  const encoded = sortedKeys
    .map(key => {
      const value = typeof data[key] === "object"
        ? JSON.stringify(data[key])
        : data[key];

      return `${key}=${value}`;
    })
    .join("&");

  const sign = crypto
    .createHash("md5")
    .update(`${encoded}${KS_SECRET}`)
    .digest("hex");

  return { sign, ...data };
}

async function postWithRetry(url, payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        timeout: 15000,
        headers: { "Content-Type": "application/json" }
      });

      const msg = String(res.data?.msg || "").replace(/\.+$/, "");

      if (msg === "TIMEOUT RETRY" && attempt < retries) {
        await sleep(2000);
        continue;
      }

      return res.data;
    } catch (err) {
      if (attempt === retries) {
        return {
          code: -1,
          msg: err.response?.data?.msg || err.message || "Request failed"
        };
      }

      await sleep(2000);
    }
  }
}

async function redeemGiftCode(fid, giftCode) {
  fid = String(fid).trim();
  giftCode = String(giftCode).trim().toUpperCase();

  if (!/^\d{4,20}$/.test(fid)) {
    return {
      fid,
      success: false,
      status: "INVALID_FID",
      message: "Invalid FID format"
    };
  }

  const loginPayload = signPayload({
    fid,
    time: Date.now()
  });

  const login = await postWithRetry(LOGIN_URL, loginPayload);

  if (!login || login.code !== 0) {
    return {
      fid,
      success: false,
      status: "LOGIN_FAILED",
      message: login?.msg || "Login failed"
    };
  }

  const nickname = login.data?.nickname || "Unknown";

  const redeemPayload = signPayload({
    fid,
    cdk: giftCode,
    time: Date.now()
  });

  const redeem = await postWithRetry(REDEEM_URL, redeemPayload);
  const rawMsg = String(redeem?.msg || "UNKNOWN").replace(/\.+$/, "");

  const messageMap = {
    SUCCESS: "Successfully redeemed",
    RECEIVED: "Already redeemed",
    "SAME TYPE EXCHANGE": "Successfully redeemed",
    "TIME ERROR": "Code expired",
    "TIMEOUT RETRY": "Temporary timeout",
    USED: "Claim limit reached",
    "CDK NOT FOUND": "Code not found",
    "PLAYER NOT FOUND": "Player not found"
  };

  return {
    fid,
    nickname,
    success: rawMsg === "SUCCESS" || rawMsg === "SAME TYPE EXCHANGE",
    alreadyRedeemed: rawMsg === "RECEIVED",
    expired: rawMsg === "TIME ERROR",
    claimLimitReached: rawMsg === "USED",
    status: rawMsg,
    message: messageMap[rawMsg] || rawMsg
  };
}

function getAllFids() {
  return Object.values(db.members).flatMap(member =>
    member.fids.map(f => ({
      discordId: member.discordId,
      discordName: member.discordName,
      fid: f.fid,
      name: f.name
    }))
  );
}

async function redeemForAllFids(code) {
  const fids = getAllFids();
  const results = [];

  for (const account of fids) {
    const result = await redeemGiftCode(account.fid, code);

    results.push({
      ...result,
      registeredName: account.name,
      discordName: account.discordName
    });

    await sleep(1200);

    if (result.expired || result.claimLimitReached) {
      break;
    }
  }

  return results;
}

function summarizeResults(code, results) {
  const success = results.filter(r => r.success).length;
  const already = results.filter(r => r.alreadyRedeemed).length;
  const failed = results.length - success - already;

  const sampleFailures = results
    .filter(r => !r.success && !r.alreadyRedeemed)
    .slice(0, 5)
    .map(r => `• ${r.registeredName || r.nickname || r.fid}: ${r.message}`)
    .join("\n");

  return [
    `🎁 **ASH Kingshot Redemption Complete**`,
    `Code: **${code}**`,
    `✅ Success: **${success}**`,
    `♻️ Already redeemed: **${already}**`,
    `❌ Failed: **${failed}**`,
    sampleFailures ? `\nFailures:\n${sampleFailures}` : ""
  ].join("\n");
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the ASH bot is online."),

  new SlashCommandBuilder()
    .setName("ashmode")
    .setDescription("Set ASH gift-code mode.")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("approval or auto")
        .setRequired(true)
        .addChoices(
          { name: "Approval", value: "approval" },
          { name: "Auto", value: "auto" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Register one of your Kingshot FIDs.")
    .addStringOption(o =>
      o.setName("fid")
        .setDescription("Kingshot FID / Player ID")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("name")
        .setDescription("In-game name for this FID")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("myids")
    .setDescription("Show your registered Kingshot FIDs."),

  new SlashCommandBuilder()
    .setName("removefid")
    .setDescription("Remove one of your registered Kingshot FIDs.")
    .addStringOption(o =>
      o.setName("fid")
        .setDescription("FID to remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("members")
    .setDescription("Show how many FIDs are registered.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("usecode")
    .setDescription("Submit and redeem a Kingshot gift code.")
    .addStringOption(o =>
      o.setName("code")
        .setDescription("Gift code")
        .setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`ASH bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("ASH bot is online.");
  }

  if (interaction.commandName === "ashmode") {
    db.mode = interaction.options.getString("mode");
    saveDb();

    return interaction.reply(`ASH gift-code mode set to **${db.mode}**.`);
  }

  if (interaction.commandName === "register") {
    const fid = interaction.options.getString("fid").trim();
    const name = interaction.options.getString("name") || interaction.user.username;

    if (!/^\d{4,20}$/.test(fid)) {
      return interaction.reply({
        content: "That FID does not look valid. Use numbers only.",
        ephemeral: true
      });
    }

    if (!db.members[interaction.user.id]) {
      db.members[interaction.user.id] = {
        discordId: interaction.user.id,
        discordName: interaction.user.username,
        fids: []
      };
    }

    const existing = db.members[interaction.user.id].fids.find(x => x.fid === fid);

    if (existing) {
      existing.name = name;
      saveDb();

      return interaction.reply({
        content: `Updated FID **${fid}** as **${name}**.`,
        ephemeral: true
      });
    }

    db.members[interaction.user.id].fids.push({
      fid,
      name,
      addedAt: new Date().toISOString()
    });

    saveDb();

    return interaction.reply({
      content: `Registered **${name}** with FID **${fid}**.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "myids") {
    const member = db.members[interaction.user.id];

    if (!member || member.fids.length === 0) {
      return interaction.reply({
        content: "You have no FIDs registered.",
        ephemeral: true
      });
    }

    const list = member.fids
      .map((x, i) => `${i + 1}. **${x.name}** — \`${x.fid}\``)
      .join("\n");

    return interaction.reply({
      content: `Your registered FIDs:\n${list}`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "removefid") {
    const fid = interaction.options.getString("fid").trim();
    const member = db.members[interaction.user.id];

    if (!member) {
      return interaction.reply({
        content: "You have no FIDs registered.",
        ephemeral: true
      });
    }

    const before = member.fids.length;
    member.fids = member.fids.filter(x => x.fid !== fid);
    saveDb();

    if (member.fids.length === before) {
      return interaction.reply({
        content: `FID **${fid}** was not found on your account.`,
        ephemeral: true
      });
    }

    return interaction.reply({
      content: `Removed FID **${fid}**.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "members") {
    const users = Object.keys(db.members).length;
    const fids = getAllFids().length;

    return interaction.reply(
      `ASH registry: **${users}** Discord members, **${fids}** total FIDs.`
    );
  }

  if (interaction.commandName === "usecode") {
    const code = interaction.options.getString("code").trim().toUpperCase();

    if (db.usedCodes.includes(code)) {
      return interaction.reply(`Code **${code}** has already been submitted.`);
    }

    const fids = getAllFids();

    if (fids.length === 0) {
      return interaction.reply("No ASH FIDs are registered yet.");
    }

    db.usedCodes.push(code);
    saveDb();

    await interaction.reply(
      `🎁 ASH code received: **${code}**\nRedeeming for **${fids.length}** registered FIDs now...`
    );

    const results = await redeemForAllFids(code);
    const summary = summarizeResults(code, results);

    return interaction.followUp(summary);
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const matches = message.content.match(/\b[A-Z0-9]{6,20}\b/g);
  if (!matches) return;

  for (const possibleCode of matches) {
    if (db.usedCodes.includes(possibleCode)) continue;

    await message.reply(
      `Possible Kingshot code detected: **${possibleCode}**\nCurrent mode: **${db.mode}**\nUse \`/usecode ${possibleCode}\` to redeem it.`
    );
  }
});

await registerCommands();
await client.login(token);
