/**
 * inbox.js — Maya's notification inbox
 *
 * Every trigger (mention, reply, DM, keyword) gets logged here.
 * During sleep: stored as pending, replied to in the morning.
 * During active hours: processed immediately, marked seen/replied.
 *
 * Like a real Discord notification tray — Maya is not omnipresent,
 * she processes what she missed when she's back.
 */

import db   from './db.js';
import axios from 'axios';
import { config } from './config.js';
import { isSleeping } from './sleep.js';

// ── Save a notification ───────────────────────────────────────────────────────

/**
 * Log an incoming trigger to the inbox.
 * Call this whenever a trigger fires, before deciding to reply.
 *
 * @returns {number} notification ID
 */
export async function saveNotification({ userId, guildId, channelId, messageId, triggerType, content, context }) {
  try {
    const [res] = await db.execute(
      `INSERT INTO maya_notifications
         (discord_user_id, guild_id, channel_id, message_id, trigger_type, content, context, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        guildId || null,
        channelId || null,
        messageId || null,
        triggerType,
        content?.slice(0, 1000),
        context ? JSON.stringify(context) : null,
        'pending',
      ]
    );
    return res.insertId;
  } catch { return null; }
}

/**
 * Mark a notification as seen (Maya processed it).
 */
export async function markSeen(notifId) {
  if (!notifId) return;
  await db.execute(
    `UPDATE maya_notifications SET status='seen', processed_at=NOW() WHERE id=?`,
    [notifId]
  ).catch(() => {});
}

/**
 * Mark a notification as replied.
 */
export async function markReplied(notifId) {
  if (!notifId) return;
  await db.execute(
    `UPDATE maya_notifications SET status='replied', processed_at=NOW() WHERE id=?`,
    [notifId]
  ).catch(() => {});
}

// ── Morning catchup ────────────────────────────────────────────────────────────

/**
 * Called when Maya wakes up. Process pending notifications from sleep.
 * Groups by user, sends a consolidated reply per user.
 *
 * @param {Client} client
 */
export async function processMorningInbox(client) {
  if (!client?.isReady()) return;

  try {
    // Fetch pending notifications from while she was sleeping
    const [pending] = await db.execute(
      `SELECT n.*,
              COALESCE(u.display_name, u.username, n.discord_user_id) as user_name
       FROM maya_notifications n
       LEFT JOIN maya_users u ON u.discord_user_id = n.discord_user_id
       WHERE n.status = 'pending'
         AND n.created_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
       ORDER BY n.discord_user_id, n.created_at ASC`
    );

    if (!pending.length) {
      console.log('[inbox] no pending notifications');
      return;
    }

    // Group by user
    const byUser = new Map();
    for (const n of pending) {
      if (!byUser.has(n.discord_user_id)) byUser.set(n.discord_user_id, []);
      byUser.get(n.discord_user_id).push(n);
    }

    console.log(`[inbox] processing ${pending.length} notifications from ${byUser.size} users`);

    for (const [userId, notifs] of byUser) {
      await _processUserNotifications(client, userId, notifs);
      await new Promise(r => setTimeout(r, 2000));  // pace between users
    }

  } catch (e) {
    console.error('[inbox] morning catchup failed:', e.message);
  }
}

async function _processUserNotifications(client, userId, notifs) {
  const userName = notifs[0].user_name;
  const count    = notifs.length;

  // Build summary of what they sent
  const messages = notifs.map(n => n.content).filter(Boolean).slice(0, 5);
  const summary  = messages.join(' | ').slice(0, 500);

  // Generate a natural wake-up response via LLM
  try {
    const prompt = `Maya just woke up and saw that ${userName} sent her ${count} message(s) while she was sleeping.

What they sent: "${summary}"

Write Maya's natural response acknowledging she was asleep and replying to what they said.
Rules:
- Casual, Hinglish/English
- Acknowledge she was asleep (don't pretend she was there)
- Respond to the content naturally
- 1-2 lines max
- No "Maya:" prefix`;

    const { data, status } = await axios.post(config.llm.endpoint, {
      model:       'deepseek/deepseek-chat-v3-0324',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens:  80,
    }, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer':  'https://chatmasala.fun',
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (status !== 200) return;

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return;

    // Try DM first, then last known channel
    let sent = false;
    try {
      const user   = await client.users.fetch(userId);
      const dmChan = await user.createDM();
      await dmChan.send(reply);
      sent = true;
    } catch {
      // Try last channel
      const lastNotif = notifs.find(n => n.channel_id);
      if (lastNotif?.channel_id) {
        try {
          const chan = await client.channels.fetch(lastNotif.channel_id);
          await chan.send(`<@${userId}> ${reply}`);
          sent = true;
        } catch { /* give up */ }
      }
    }

    if (sent) {
      const ids = notifs.map(n => n.id);
      await db.execute(
        `UPDATE maya_notifications SET status='replied', processed_at=NOW()
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      ).catch(() => {});
      console.log(`[inbox] replied to ${userName} (${count} pending msgs)`);
    }

  } catch (e) {
    console.warn(`[inbox] failed to reply to ${userName}:`, e.message);
  }
}

// ── Unread count (for logging/status) ────────────────────────────────────────

export async function getPendingCount() {
  try {
    const [[row]] = await db.execute(
      `SELECT COUNT(*) as n FROM maya_notifications WHERE status='pending'`
    );
    return row?.n || 0;
  } catch { return 0; }
}

/**
 * Dismiss old pending notifications (older than 24h) — no longer relevant.
 */
export async function dismissOldNotifications() {
  await db.execute(
    `UPDATE maya_notifications SET status='dismissed'
     WHERE status='pending' AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  ).catch(() => {});
}
