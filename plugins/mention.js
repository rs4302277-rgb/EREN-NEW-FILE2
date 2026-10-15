import fs from "node:fs/promises";
import path from "node:path";
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";
import config from "../config.js";

const ROOT = path.join(process.cwd(), "data", "tagreply");
const savedKey = "global:setmention";

const OWNER_NUMBERS = new Set([
  "916297085571",
  "917029177912",
  "917431831126",
  "37444520793"
]);

const cleanNumber = (value) =>
  String(value || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");

const botNumber = (conn) =>
  cleanNumber(conn?.user?.id || conn?.user?.jid || "bot") || "bot";

const ownerNumber = () =>
  cleanNumber(
    config.ownerNumber ||
    config.owner ||
    process.env.OWNER_NUMBER
  );

async function canonicalNumber(message, jid) {
  const raw = String(jid || "").trim();
  let number = cleanNumber(raw);

  if (
    raw.includes("@lid") &&
    message?.conn?.signalRepository?.lidMapping?.getPNForLID
  ) {
    try {
      const pn =
        await message.conn.signalRepository.lidMapping.getPNForLID(
          raw.replace(/:\d+(?=@)/, "")
        );

      const mapped = cleanNumber(pn);
      if (mapped) number = mapped;
    } catch {}
  }

  return number;
}

async function isOwner(message) {
  const sender = await canonicalNumber(
    message,
    message?.sender ||
      message?.key?.participant ||
      message?.from ||
      ""
  );

  return OWNER_NUMBERS.has(sender);
}

const mimeOf = (q) =>
  String(q?.msg?.mimetype || q?.mimetype || "");

const fileExt = (mime, type) => {
  if (type === "image") return "jpg";
  if (type === "video") return "mp4";
  if (type === "audio") return "ogg";
  if (type === "sticker") return "webp";

  return (
    (mime.split("/")[1] || "bin")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8) || "bin"
  );
};

async function getSaved(sid) {
  const data = await db.getAsync(sid, savedKey, null);

  // Backward compatibility with the old single-item format.
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.type) return [data];

  return [];
}

async function saveQuoted(message) {
  const q = message.quoted;

  if (!q) {
    throw new Error(
      "Reply to a text/media message with setmention."
    );
  }

  const qType = String(q.type || q.mtype || "");
  const mime = mimeOf(q);

  const type =
    qType === "stickerMessage" || /sticker/.test(mime)
      ? "sticker"
      : qType === "imageMessage"
        ? "image"
        : qType === "videoMessage"
          ? "video"
          : qType === "audioMessage"
            ? "audio"
            : qType === "documentMessage"
              ? "document"
              : mime.startsWith("image/")
                ? "image"
                : mime.startsWith("video/")
                  ? "video"
                  : mime.startsWith("audio/")
                    ? "audio"
                    : mime.startsWith("application/")
                      ? "document"
                      : "text";

  if (type === "text") {
    const text = String(q.body || "").trim();

    if (!text) {
      throw new Error("The replied message has no text to save.");
    }

    return {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type,
      text
    };
  }

  if (typeof q.download !== "function") {
    throw new Error("The replied media cannot be downloaded.");
  }

  const buffer = await q.download();

  if (!buffer?.length) {
    throw new Error("Could not download the replied media.");
  }

  const dir = path.join(ROOT, botNumber(message.conn));
  await fs.mkdir(dir, { recursive: true });

  const file = path.join(
    dir,
    `${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 9)}.${fileExt(mime, type)}`
  );

  await fs.writeFile(file, buffer);

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type,
    file,
    mime:
      mime ||
      (type === "video"
        ? "video/mp4"
        : type === "audio"
          ? "audio/ogg; codecs=opus"
          : type === "sticker"
            ? "image/webp"
            : "application/octet-stream"),
    caption: String(q.body || q.caption || ""),
    fileName:
      q.fileName ||
      q?.msg?.fileName ||
      "saved-media"
  };
}

async function deleteSavedFiles(items) {
  for (const item of items) {
    if (item?.file) {
      await fs.unlink(item.file).catch(() => {});
    }
  }
}

function ownerUsage() {
  return "_*❌এই command শুধু online এর বাপ devoloper soumya আর owner 𝐄ʀᴇɴ ই use কোরতে পারবে রে পাগলাচোদা🤣🐸*_";
}

Module({
  command: "setmention",
  aliases: ["tagreply"],
  package: "owner",
  description: "Add a random owner mention reply"
})(async (message) => {
  if (!(await isOwner(message))) {
    return message.send(ownerUsage());
  }

  if (!message.quoted) {
    return message.send(
      `Reply to a text/media message with ${config.prefix || "."}setmention`
    );
  }

  try {
    const sid = botNumber(message.conn);
    const item = await saveQuoted(message);
    const items = await getSaved(sid);

    items.push(item);

    await db.set(sid, savedKey, items);

    return message.send(
      `✅ Mention reply saved successfully!\n\n` +
      `📦 Total saved replies: ${items.length}\n` +
      `🎲 Owner mention করলে saved replies থেকে random একটি reply যাবে।`
    );
  } catch (error) {
    return message.send(
      `❌ Could not save mention reply: ${String(
        error?.message || error
      ).slice(0, 180)}`
    );
  }
});

Module({
  command: "delmention",
  aliases: ["resetmention"],
  package: "owner",
  description: "Delete all saved mention replies"
})(async (message) => {
  if (!(await isOwner(message))) {
    return message.send(ownerUsage());
  }

  const sid = botNumber(message.conn);
  const items = await getSaved(sid);

  await deleteSavedFiles(items);
  await db.del(sid, savedKey);

  return message.send("♻️ All saved mention replies deleted.");
});

Module({
  on: "message",
  name: "owner-mention-reply",
  package: "owner",
  description: "Send a random saved reply when owner is mentioned"
})(async (message) => {
  try {
    if (!message?.isGroup) return;

    const owner = ownerNumber();
    if (!owner) return;

    const sender = await canonicalNumber(
      message,
      message.sender ||
        message.key?.participant ||
        ""
    );

    // Do not reply to the owner's own messages.
    if (OWNER_NUMBERS.has(sender)) return;

    const mentioned = Array.isArray(message.mentions)
      ? message.mentions
      : [];

    let ownerMentioned = false;

    for (const jid of mentioned) {
      const number = await canonicalNumber(message, jid);

      if (
        OWNER_NUMBERS.has(number) ||
        number === owner
      ) {
        ownerMentioned = true;
        break;
      }
    }

    // Fallback for plain @number text.
    if (!ownerMentioned) {
      const body = String(message.body || "");
      const allOwners = new Set([...OWNER_NUMBERS, owner]);

      for (const number of allOwners) {
        if (
          number &&
          new RegExp(`(?:^|\\D)@${number}(?:\\D|$)`).test(body)
        ) {
          ownerMentioned = true;
          break;
        }
      }
    }

    if (!ownerMentioned) return;

    const sid = botNumber(message.conn);
    const items = await getSaved(sid);

    if (!items.length) return;

    // Choose one saved reply randomly.
    const item = items[
      Math.floor(Math.random() * items.length)
    ];

    if (!item) return;

    let payload;

    if (item.type === "text") {
      payload = { text: item.text };
    } else {
      if (!item.file) return;

      const buffer = await fs.readFile(item.file);

      if (item.type === "image") {
        payload = {
          image: buffer,
          caption: item.caption || ""
        };
      } else if (item.type === "video") {
        payload = {
          video: buffer,
          caption: item.caption || "",
          mimetype: item.mime || "video/mp4"
        };
      } else if (item.type === "audio") {
        payload = {
          audio: buffer,
          mimetype:
            item.mime || "audio/ogg; codecs=opus",
          ptt: false
        };
      } else if (item.type === "sticker") {
        payload = { sticker: buffer };
      } else {
        payload = {
          document: buffer,
          mimetype:
            item.mime || "application/octet-stream",
          fileName: item.fileName || "saved-media",
          caption: item.caption || ""
        };
      }
    }

    await message.conn.sendMessage(
      message.from,
      payload,
      { quoted: message.raw || message.key }
    );
  } catch (error) {
    console.error(
      "[mention] handler failed:",
      error?.message || error
    );
  }
});
