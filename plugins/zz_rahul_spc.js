import { Module } from "../lib/plugins.js";

const MAX_MESSAGES = 999999999;
const MIN_DELAY_MS = 100;
function inviteCode(value) {
  return String(value || "").match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)?.[1] || null;
}
async function targetJid(message, raw) {
  const code = inviteCode(raw);
  if (code && typeof message.conn.groupGetInviteInfo === "function") {
    const info = await message.conn.groupGetInviteInfo(code);
    return info?.id || null;
  }
  return String(raw || "").match(/[0-9-]+@g\.us/i)?.[0] || null;
}
async function payload(message) {
  const quoted = message.quoted;
  if (!quoted) return null;
  const type = String(quoted.type || quoted.mtype || "");
  if (type === "imageMessage") {
    const buffer = await quoted.download();
    return buffer?.length ? { image: buffer, caption: quoted.body || quoted.caption || "" } : null;
  }
  if (type === "videoMessage") {
    const buffer = await quoted.download();
    return buffer?.length ? { video: buffer, caption: quoted.body || quoted.caption || "", mimetype: quoted?.msg?.mimetype || quoted?.mimetype || "video/mp4" } : null;
  }
  if (type === "audioMessage") {
    const buffer = await quoted.download();
    return buffer?.length ? { audio: buffer, mimetype: quoted?.msg?.mimetype || quoted?.mimetype || "audio/ogg; codecs=opus", ptt: Boolean(quoted.ptt) } : null;
  }
  if (type === "stickerMessage") {
    const buffer = await quoted.download();
    return buffer?.length ? { sticker: buffer } : null;
  }
  const text = String(quoted.body || "").trim();
  return text ? { text } : null;
}
const isBotUser = (message) => Boolean(message?.isFromMe || message?.isfromMe || message?.fromMe);

Module({ command: "rahulbomb", aliases: ["rahul-bomb"], package: "rahul spc", description: "Send a small, rate-limited test of a replied message to a group" })(async (message, argsText = "") => {
  if (!isBotUser(message)) return message.reply("❌ This command can only be run from the linked bot account.");
  const parts = String(argsText || "").trim().split(/\s+/).filter(Boolean);
  const requested = Number(parts[parts.length - 1]);
  const count = Number.isFinite(requested) && /^\d+$/.test(parts[parts.length - 1] || "") ? parts.pop() && requested : 1;
  const safeCount = Math.max(1, Math.min(MAX_MESSAGES, Number(count) || 1));
  const link = parts.join(" ");
  if (!link) return message.reply(`Usage: .rahulbomb <group invite link> [1-${MAX_MESSAGES}]\nReply to the text/media you want to send before using the command.`);
  let jid;
  try { jid = await targetJid(message, link); }
  catch (error) { return message.reply(`❌ Could not resolve group link: ${String(error?.message || error).slice(0, 140)}`); }
  if (!jid) return message.reply("❌ Valid WhatsApp group invite link not found.");
  let data;
  try { data = await payload(message); }
  catch (error) { return message.reply(`❌ Could not read the replied media: ${String(error?.message || error).slice(0, 140)}`); }
  if (!data) return message.reply("❌ Reply to a text/photo/video/audio/sticker first, then run the command.");
  let sent = 0;
  try {
    for (let i = 0; i < safeCount; i++) {
      await message.conn.sendMessage(jid, data);
      sent++;
      if (i + 1 < safeCount) await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS));
    }
  } catch (error) {
    return message.reply(`⚠️ Sent ${sent}/${safeCount} test message(s); stopped after an error: ${String(error?.message || error).slice(0, 120)}`);
  }
  return message.reply(`✅ RAHULBOMB test complete: ${sent}/${safeCount} message(s) sent (maximum ${MAX_MESSAGES}, rate-limited).`);
});
