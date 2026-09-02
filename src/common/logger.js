/**
 * Small logging helper.
 *
 * Keeps a bounded in-memory ring buffer so the panel's log view can be
 * populated even when it was closed while the interesting events happened.
 */

import { MSG, broadcast } from './messages.js';

const MAX_ENTRIES = 500;
const entries = [];

function record(level, scope, message, detail) {
  const entry = { at: Date.now(), level, scope, message, detail };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, detail ?? '');
  else if (level === 'warn') console.warn(line, detail ?? '');
  else console.log(line, detail ?? '');
  broadcast(MSG.LOG, entry);
  return entry;
}

export function createLogger(scope) {
  return {
    info: (message, detail) => record('info', scope, message, detail),
    warn: (message, detail) => record('warn', scope, message, detail),
    error: (message, detail) => record('error', scope, message, detail),
  };
}

export function recentLogs() {
  return [...entries];
}
