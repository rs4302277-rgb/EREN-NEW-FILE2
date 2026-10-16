import { Module } from "../lib/plugins.js";
import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  generateMessageID,
  jidNormalizedUser
} from "@whiskeysockets/baileys";
import crypto from "crypto";

// Group context check only. No admin permission is required.
async function ensureGroupContext(m) {
  if (!m?.isGroup) {
    await m.send("❌ ᴘʟᴇᴀsᴇ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ɪɴ ᴀ ɢʀᴏᴜᴘ.");
    return false;
  }
  return true;
}

// Build and relay a native group-status message.
async function relayStatus(conn, jid, storyData) {
  if (!jid?.endsWith("@g.us")) {
    throw new Error("Invalid group JID");
  }

  if (!conn?.user?.id) {
    throw new Error("WhatsApp session is not connected");
  }

  const senderJid = jidNormalizedUser(conn.user.id);

  const contextInfo = {
    forwardingScore: 0,
    featureEligibilities: {
      canBeReshared: true,
      canReceiveMultiReact: true
    },
    pairedMediaType: 0,
    statusSourceType: 4,
    statusAttributions: [
      {
        type: 6,
        groupStatus: { authorJid: senderJid }
      }
    ],
    isGroupStatus: true,
    statusAudienceMetadata: {
      audienceType: 1,
      listEmoji: "📌",
      listName: "Group Status"
    }
  };

  if (storyData?.text != null) {
    const messageSecret = crypto.randomBytes(32);

    const inner = {
      extendedTextMessage: {
        text: String(storyData.text),
        backgroundArgb:
          (storyData.backgroundColor ?? 0xff128c7e) >>> 0,
        textArgb: 0xffffffff,
        font: Number.isInteger(storyData.font)
          ? storyData.font
          : 1,
        contextInfo
      },
      messageContextInfo: { messageSecret }
    };

    const envelope = {
      messageContextInfo: { messageSecret },
      groupStatusMessageV2: { message: inner }
    };

    const generated = generateWAMessageFromContent(
      jid,
      envelope,
      { userJid: senderJid }
    );

    await conn.relayMessage(jid, generated.message, {
      messageId: generated.key?.id || generateMessageID()
    });

    return;
  }

  const generatedContent = await generateWAMessageContent(
    storyData,
    { upload: conn.waUploadToServer.bind(conn) }
  );

  const inner = generatedContent?.message || generatedContent;

  if (!inner || typeof inner !== "object") {
    throw new Error("Could not build group-status media payload");
  }

  const mediaKey = Object.keys(inner).find(key =>
    [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "stickerMessage"
    ].includes(key)
  );

  if (!mediaKey) {
    throw new Error(
      "Unsupported media type. Use an image, video, audio or sticker."
    );
  }

  inner[mediaKey].contextInfo = {
    ...(inner[mediaKey].contextInfo || {}),
    ...contextInfo
  };

  const messageSecret = crypto.randomBytes(32);
  inner.messageContextInfo = { messageSecret };

  const envelope = {
    messageContextInfo: { messageSecret },
    groupStatusMessageV2: { message: inner }
  };

  const generated = generateWAMessageFromContent(
    jid,
    envelope,
    { userJid: senderJid }
  );

  await conn.relayMessage(jid, generated.message, {
    messageId: generated.key?.id || generateMessageID()
  });
}

// Convert replied media into a payload suitable for status posting.
async function storyFromQuoted(q, caption = "") {
  if (!q) return null;

  const rawType = String(
    q.type ||
    q.mtype ||
    (q.msg && Object.keys(q.msg)[0]) ||
    (q.message && Object.keys(q.message)[0]) ||
    ""
  );

  const type = /image/i.test(rawType)
    ? "imageMessage"
    : /video/i.test(rawType)
    ? "videoMessage"
    : /audio/i.test(rawType)
    ? "audioMessage"
    : /sticker/i.test(rawType)
    ? "stickerMessage"
    : /document/i.test(rawType)
    ? "documentMessage"
    : rawType;

  if (
    ![
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "stickerMessage",
      "documentMessage"
    ].includes(type)
  ) {
    return null;
  }

  if (type === "documentMessage") {
    throw new Error(
      "Documents are not supported by this group-status sender."
    );
  }

  if (typeof q.download !== "function") {
    throw new Error("Cannot download the replied media");
  }

  const media = await q.download();

  if (!media?.length) {
    throw new Error("Media download failed");
  }

  if (type === "imageMessage") {
    return {
      image: media,
      caption: caption || q.body || q.caption || ""
    };
  }

  if (type === "videoMessage") {
    return {
      video: media,
      caption: caption || q.body || q.caption || ""
    };
  }

  if (type === "audioMessage") {
    return {
      audio: media,
      mimetype: q.mimetype || "audio/ogg; codecs=opus",
      ptt: !!q.ptt
    };
  }

  if (type === "stickerMessage") {
    return { sticker: media };
  }

  return null;
}

// GSTATUS: reply to media/text and post to the current or target group.
Module({
  command: "gstatus",
  aliases: ["gs", "gcstatus", "groupstatus", "poststatus"],
  package: "group",
  description: "Post replied media or text as group status"
})(async (m, a) => {
  try {
    const quoted = m.reply_message;

    if (
      !quoted ||
      (!quoted.image && !quoted.video && !quoted.txt)
    ) {
      return await m.send(
        "Reply to an image, video, or text with `.gstatus <jid>`"
      );
    }

    const groupJids = parsedJid(a);

    if (!groupJids.length) {
      if (!m.isGroup) {
        return await m.send(
          "Use this in a group, or pass a group JID: `.gstatus <jid>`"
        );
      }

      // Admin check intentionally removed.
      await m.groupStatus(m, m.jid);

      return await m.send("Group status updated.");
    }

    let sent = 0;
    let failed = 0;

    for (const jid of groupJids) {
      if (!isGroup(jid)) continue;

      try {
        // Admin check intentionally removed.
        await m.groupStatus(m, jid);
        sent++;
      } catch (err) {
        failed++;
        console.error("[gstatus]", jid, err?.message || err);
      }
    }

    return await m.send(
      `╭━━〔 ɢsᴛᴀᴛᴜs 〕━━╮\n` +
      `┃ sᴇɴᴛ : ${sent}\n` +
      `┃ ғᴀɪʟᴇᴅ : ${failed}\n` +
      `╰━━━━━━━━━━━━━━╯`
    );
  } catch (err) {
    console.error("[gstatus]", err);

    return await m.send(
      `❌ GSTATUS ERROR: ${String(err?.message || err).slice(0, 180)}`
    );
  }
});

// GSTATUSALL: post text or replied media to all joined groups.
Module({
  command: "gstatusall",
  aliases: ["gsall"],
  package: "group",
  description: "Post text or replied media to group statuses"
})(async (m, a) => {
  try {
    if (!(await ensureGroupContext(m))) return;

    const caption = String(a || "").trim();
    const quoted = m.quoted || m.reply_message;
    const media = await storyFromQuoted(quoted, caption);

    if (!media && !caption) {
      return await m.send(
        "❌ ᴛᴇxᴛ ᴅᴀᴏ ʙᴀ ᴍᴇᴅɪᴀ ʀᴇᴘʟʏ ᴋᴏʀᴏɴ."
      );
    }

    const story = media || {
      text: caption,
      backgroundColor: 0xff128c7e,
      font: 1
    };

    const groups = await m.conn.groupFetchAllParticipating();
    const ids = Object.keys(groups || {});

    let sent = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        await relayStatus(m.conn, id, story);
        sent++;
      } catch (err) {
        failed++;
        console.error(
          "[gstatusall]",
          id,
          err?.message || err
        );
      }
    }

    return await m.send(
      `╭━━〔 ɢsᴛᴀᴛᴜsᴀʟʟ 〕━━╮\n` +
      `┃ ᴛᴏᴛᴀʟ : ${ids.length}\n` +
      `┃ sᴇɴᴛ : ${sent}\n` +
      `┃ ғᴀɪʟᴇᴅ : ${failed}\n` +
      `╰━━━━━━━━━━━━━━╯`
    );
  } catch (err) {
    console.error("[gstatusall]", err);

    return await m.send(
      `❌ ɢsᴛᴀᴛᴜsᴀʟʟ ᴇʀʀᴏʀ : ${
        String(err?.message || err).slice(0, 180)
      }`
    );
  }
});
