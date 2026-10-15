import fs from "node:fs/promises";
import path from "node:path";
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";
import config from "../config.js";

const ROOT = path.join(process.cwd(), "data", "tagreply");
const savedKey = "global:setmention";
const cleanNumber = (value) => String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
const botNumber = (conn) => cleanNumber(conn?.user?.id || conn?.user?.jid || "bot") || "bot";
const ownerNumber = () => cleanNumber(config.ownerNumber || config.owner || process.env.OWNER_NUMBER);
const isOwner = (message) => {
  const sender = cleanNumber(message?.sender || message?.key?.participant || "");
  return Boolean(ownerNumber() && sender === ownerNumber());
};
const mimeOf = (q) => String(q?.msg?.mimetype || q?.mimetype || "");
const fileExt = (mime, type) => type === "image" ? "jpg" : type === "video" ? "mp4" : type === "audio" ? "ogg" : type === "sticker" ? "webp" : (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";

async function saveQuoted(message) {
  const q = message.quoted;
  if (!q) throw new Error("Reply to a text, photo, video, audio, sticker or document.");
  const qType = String(q.type || q.mtype || "");
  const mime = mimeOf(q);
  const type = qType === "stickerMessage" || /sticker/.test(mime) ? "sticker"
    : qType === "imageMessage" ? "image"
    : qType === "videoMessage" ? "video"
    : qType === "audioMessage" ? "audio"
    : qType === "documentMessage" ? "document"
    : mime.startsWith("image/") ? "image"
    : mime.startsWith("video/") ? "video"
    : mime.startsWith("audio/") ? "audio"
    : mime.startsWith("application/") ? "document" : "text";
  if (type === "text") {
    const text = String(q.body || "").trim();
    if (!text) throw new Error("The replied message has no text to save.");
    return { type, text, savedAt: Date.now() };
  }
  if (typeof q.download !== "function") throw new Error("The replied media cannot be downloaded.");
  const buffer = await q.download();
  if (!buffer?.length) throw new Error("Could not download the replied media.");
  const dir = path.join(ROOT, botNumber(message.conn));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${fileExt(mime, type)}`);
  await fs.writeFile(file, buffer);
  return { type, file, mime: mime || (type === "video" ? "video/mp4" : type === "audio" ? "audio/ogg; codecs=opus" : type === "sticker" ? "image/webp" : "application/octet-stream"), caption: String(q.body || q.caption || ""), fileName: q.fileName || q?.msg?.fileName || "saved-media", savedAt: Date.now() };
}

async function getSaved(sid) {
  const value = await db.getAsync(sid, savedKey, null);
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
async function deleteItems(items) {
  await Promise.all(items.filter((item) => item?.file).map((item) => fs.unlink(item.file).catch(() => {})));
}
async function clearSaved(sid) {
  await deleteItems(await getSaved(sid));
  await db.del(sid, savedKey);
}
function ownerUsage() { return "❌ Only the configured owner number can use this command."; }

Module({ command: "setmention", aliases: ["tagreply"], package: "owner", description: "Add a text or media reply to the random owner-mention replies" })(async (message) => {
  if (!isOwner(message)) return message.send(ownerUsage());
  if (!message.quoted) return message.send(`Reply to a text/media message with ${config.prefix || "."}setmention to add it to the random replies.`);
  try {
    const sid = botNumber(message.conn);
    const item = await saveQuoted(message);
    const items = await getSaved(sid);
    items.push(item);
    await db.set(sid, savedKey, items);
    return message.send(`✅ Mention reply added (${item.type}).\n📦 Saved replies: ${items.length}\nWhen anyone mentions/tags the owner in a group, one saved reply will be chosen randomly.`);
  } catch (error) {
    return message.send(`❌ Could not save mention reply: ${String(error?.message || error).slice(0, 180)}`);
  }
});

Module({ command: "delmention", aliases: ["resetmention"], package: "owner", description: "Delete all saved owner-mention replies" })(async (message) => {
  if (!isOwner(message)) return message.send(ownerUsage());
  const sid = botNumber(message.conn);
  await clearSaved(sid);
  return message.send("♻️ All saved mention replies deleted.");
});

function collectContextInfo(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (value.contextInfo && typeof value.contextInfo === "object") out.push(value.contextInfo);
  for (const [key, child] of Object.entries(value)) {
    if (key === "contextInfo") continue;
    if (child && typeof child === "object") collectContextInfo(child, out);
  }
  return out;
}
async function ownerWasMentioned(message, owner) {
  const mentions = new Set();
  const add = (jid) => { if (jid) mentions.add(String(jid).toLowerCase()); };
  for (const jid of (Array.isArray(message.mentions) ? message.mentions : [])) add(jid);
  const raw = message.raw || message;
  for (const info of collectContextInfo(raw.message || raw)) {
    for (const jid of (info.mentionedJid || info.mentionedJids || [])) add(jid);
  }
  const targetDigits = new Set([owner]);
  const targetJids = new Set([`${owner}@s.whatsapp.net`, `${owner}@c.us`]);
  try {
    const result = await message.conn.onWhatsApp?.(`${owner}@s.whatsapp.net`);
    for (const item of (Array.isArray(result) ? result : result ? [result] : [])) {
      if (item?.jid) targetJids.add(String(item.jid).toLowerCase());
      if (item?.lid) targetJids.add(String(item.lid).toLowerCase());
      if (item?.phoneNumber) targetDigits.add(cleanNumber(item.phoneNumber));
    }
  } catch {}
  // LID mentions can only be mapped reliably against the group's participant metadata.
  try {
    const metadata = await message.conn.groupMetadata(message.from || message.key?.remoteJid);
    for (const participant of metadata?.participants || []) {
      const phone = cleanNumber(participant.phoneNumber || participant.phone || participant.jid || "");
      if (phone === owner || cleanNumber(participant.id) === owner) {
        if (participant.id) targetJids.add(String(participant.id).toLowerCase());
        if (participant.jid) targetJids.add(String(participant.jid).toLowerCase());
        if (participant.lid) targetJids.add(String(participant.lid).toLowerCase());
      }
    }
  } catch {}
  for (const jid of mentions) {
    if (targetJids.has(jid) || targetDigits.has(cleanNumber(jid))) return true;
  }
  const body = String(message.body || "");
  return new RegExp(`(?:^|\\D)@${owner}(?:\\D|$)`).test(body);
}

Module({ on: "message", name: "owner-mention-reply", package: "owner", description: "Randomly reply when the owner is mentioned or tagged in a group" })(async (message) => {
  try {
    if (!message?.isGroup) return;
    const owner = ownerNumber();
    if (!owner) return;
    const sender = cleanNumber(message.sender || message.key?.participant || "");
    if (sender === owner) return;
    if (!(await ownerWasMentioned(message, owner))) return;
    const items = await getSaved(botNumber(message.conn));
    const available = items.filter((item) => item?.type === "text" ? Boolean(item.text) : Boolean(item.file));
    if (!available.length) return;
    const item = available[Math.floor(Math.random() * available.length)];
    let payload;
    if (item.type === "text") payload = { text: item.text };
    else {
      const buffer = await fs.readFile(item.file);
      if (item.type === "image") payload = { image: buffer, caption: item.caption || "" };
      else if (item.type === "video") payload = { video: buffer, caption: item.caption || "", mimetype: item.mime || "video/mp4" };
      else if (item.type === "audio") payload = { audio: buffer, mimetype: item.mime || "audio/ogg; codecs=opus", ptt: false };
      else if (item.type === "sticker") payload = { sticker: buffer };
      else payload = { document: buffer, mimetype: item.mime || "application/octet-stream", fileName: item.fileName || "saved-media", caption: item.caption || "" };
    }
    await message.conn.sendMessage(message.from, payload, { quoted: message.raw || message.key });
  } catch (error) {
    console.error("[mention] handler failed:", error?.message || error);
  }
});
