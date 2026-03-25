/**
 * lock.js — Distributed message lock using MySQL
 *
 * Prevents multiple Koyeb instances from processing the same
 * Discord message simultaneously.
 *
 * Uses INSERT IGNORE into a locks table — only the first instance
 * to insert wins. Others get a duplicate key error and skip.
 *
 * Locks auto-expire after 30 seconds via the created_at column
 * so stale locks from crashed instances never block forever.
 */

import db from './db.js';

const LOCK_TTL_SECONDS = 30;

/**
 * Try to acquire a lock for the given key.
 * @returns {Promise<boolean>} true if lock acquired, false if already taken
 */
export async function acquireLock(key) {
  try {
    // Clean up expired locks first (older than TTL)
    await db.execute(
      `DELETE FROM maya_locks
       WHERE created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
      [LOCK_TTL_SECONDS]
    );

    // Try to insert — INSERT IGNORE silently fails on duplicate key
    const [result] = await db.execute(
      `INSERT IGNORE INTO maya_locks (lock_key, created_at) VALUES (?, NOW())`,
      [key]
    );

    // affectedRows = 1 means we got the lock, 0 means someone else has it
    return result.affectedRows === 1;

  } catch (err) {
    // If the table doesn't exist yet, log and allow (fail open)
    console.error('[lock] acquireLock error:', err.message);
    return true;
  }
}

/**
 * Release a lock after processing is complete.
 */
export async function releaseLock(key) {
  try {
    await db.execute(`DELETE FROM maya_locks WHERE lock_key = ?`, [key]);
  } catch (err) {
    console.error('[lock] releaseLock error:', err.message);
  }
}
