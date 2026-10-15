import { Module } from "../lib/plugins.js";

// Active mutes are session-memory only; a bot restart clears them.
const mutedUntil = new Map();
const cleanJid = (v) => String(v || "").trim().replace(/:\d+(?=@)/, "");
const digits = (v) => String(v || "").split("@")[0].split(":")[0].replace(/\D/g, "");
const sameJid = (a, b) => {
  const aa = digits(a), bb = digits(b);
  return !!aa && aa === bb;
};
async function stableUserKey(m, jid) {
  const raw = cleanJid(jid);
  if (!raw) return "";
  if (raw.includes("@lid") && m?.conn?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await m.conn.signalRepository.lidMapping.getPNForLID(raw.replace(/:\d+(?=@)/, ""));
      if (pn) return cleanJid(pn);
    } catch {}
  }
  return raw;
}
function parseDuration(v) {
  const match = String(v || "").trim().match(/^([1-9]\d{0,5})(s|m|h)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = n * (unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000);
  return ms > 0 && ms <= 24 * 3600000 ? ms : null;
}
function findTarget(m) {
  return (Array.isArray(m?.mentions) && m.mentions[0]) || m?.quoted?.sender || m?.quoted?.participant || m?.quoted?.key?.participant || "";
}
async function checkGroupAdmin(m, command) {
  if (!m?.isGroup) { await m.send(`❌ .${command} only works in a group.`); return false; }
  await m.loadGroupInfo?.();
  if (!(m.isAdmin || m.isGroupAdmin || m.isFromMe || m.isfromMe)) {
    await m.send("❌ Only group admins can use this command."); return false;
  }
  if (!m.isBotAdmin) { await m.send("❌ Make the bot a group admin first so it can delete messages."); return false; }
  return true;
}
function muteKey(group, target) { return `${group}:${target}`; }

Module({ command: "muteuser", package: "group", description: "Temporarily delete messages from a mentioned member" })(async (m, args) => {
  if (!(await checkGroupAdmin(m, "muteuser"))) return;
  const targetRaw = findTarget(m);
  const durationText = String(args || "").trim().split(/\s+/).filter(Boolean).pop() || "";
  const duration = parseDuration(durationText);
  if (!targetRaw || !duration) return m.send(`Usage: ${(m.conn?.prefix || ".")}muteuser @user 10s\nExamples: 10s, 5m, 2h (maximum 24h).`);
  const target = await stableUserKey(m, targetRaw);
  if (!target || !target.includes("@")) return m.send("❌ Could not identify the mentioned user.");
  if (sameJid(target, m.conn?.user?.id) || sameJid(target, m.conn?.user?.lid)) return m.send("❌ I cannot mute the bot itself.");
  if ((m.groupAdmins || []).some((a) => sameJid(a?.id || a?.jid || a, target))) return m.send("❌ Group admins cannot be muted.");
  const until = Date.now() + duration;
  mutedUntil.set(muteKey(m.from, target), until);
  return m.send(`_🔇 @${digits(target)} তোর বাবা 𝐄ʀᴇɴ তোকে ${durationText.toLowerCase()} সময় ধরে বন্ধ রাখলো এখন তুই শুধু 𝟑𝐱 এর 𝐏𝙾𝚆𝙴𝚁 𝐅𝙸𝙻𝙻 কর🐸💪🏻*_`, { mentions: [target] });
});

Module({ command: "unmuteuser", package: "group", description: "Remove a temporary mute from a member" })(async (m) => {
  if (!(await checkGroupAdmin(m, "unmuteuser"))) return;
  const targetRaw = findTarget(m);
  if (!targetRaw) return m.send("Usage: .unmuteuser @user (or reply to that user's message).");
  const target = await stableUserKey(m, targetRaw);
  const key = muteKey(m.from, target);
  let removed = mutedUntil.delete(key);
  // Also clear an LID/PN variant if the map was created before mapping was available.
  for (const existing of mutedUntil.keys()) {
    const split = existing.indexOf(":");
    if (split < 0 || existing.slice(0, split) !== m.from) continue;
    if (sameJid(existing.slice(split + 1), target)) { mutedUntil.delete(existing); removed = true; }
  }
  return m.send(removed ? `🔊 @${digits(target)} has been unmuted.` : "ℹ️ This user does not have an active mute in this group.", { mentions: [target] });
});

Module({ on: "message", package: "group", description: "Enforce temporary muteuser timers" })(async (m) => {
  try {
    if (!m?.isGroup) return;
    const senderRaw = m.sender || m.key?.participant || "";
    if (!senderRaw) return;
    const sender = await stableUserKey(m, senderRaw);
    const key = muteKey(m.from, sender);
    let until = mutedUntil.get(key);
    if (!until) {
      // Match a previously stored LID/PN alias when the mapping appeared later.
      for (const [existing, value] of mutedUntil.entries()) {
        const split = existing.indexOf(":");
        if (split >= 0 && existing.slice(0, split) === m.from && sameJid(existing.slice(split + 1), sender)) {
          until = value; break;
        }
      }
    }
    if (!until) return;
    if (Date.now() >= until) { mutedUntil.delete(key); return; }
    await m.loadGroupInfo?.();
    if (m.isAdmin || m.isGroupAdmin || m.isFromMe || m.isfromMe || sameJid(sender, m.conn?.user?.id) || sameJid(sender, m.conn?.user?.lid)) return;
    if (!m.isBotAdmin) return;
    try { await m.conn.sendMessage(m.from, { delete: m.key }); }
    catch (e) { console.error("[muteuser] message deletion failed:", e?.message || e); }
  } catch (e) { console.error("[muteuser] enforcement failed:", e?.message || e); }
});
