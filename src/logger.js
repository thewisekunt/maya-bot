import fs   from 'fs';
import path  from 'path';
import { config } from './config.js';

const logDir = path.join(process.cwd(), 'logs');

export function debugLog({ userId, prefName, entropy, zone, message, reply }) {
  if (!config.bot.debugLog) return;

  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const date    = new Date().toISOString().slice(0, 10);       // YYYY-MM-DD
    const time    = new Date().toTimeString().slice(0, 8);       // HH:MM:SS
    const logFile = path.join(logDir, `maya_${date}.log`);

    const entry = [
      `[${time}] user=${userId}(${prefName}) entropy=${entropy} zone=${zone}`,
      `  MSG: ${message.replace(/\n/g, ' ')}`,
      `  BOT: ${reply.replace(/\n/g, ' ')}`,
      '',
    ].join('\n');

    fs.appendFileSync(logFile, entry, 'utf8');
  } catch (e) {
    console.error('[logger] Failed to write log:', e.message);
  }
}
