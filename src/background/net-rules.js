/**
 * declarativeNetRequest bookkeeping.
 *
 * The static ruleset in rules/referer.json attaches a Referer to CDN requests.
 * This module exists to confirm at runtime that the rule is actually in force,
 * because the failure mode otherwise is every single image 403-ing with no
 * indication of why.
 */

import { createLogger } from '../common/logger.js';

const log = createLogger('net-rules');
export const RULESET_ID = 'referer_rules';

/** Ensure the static ruleset is enabled (a user or another rule could disable it). */
export async function ensureRulesEnabled() {
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    if (enabled.includes(RULESET_ID)) return true;
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [RULESET_ID] });
    log.info('Referer ruleset enabled');
    return true;
  } catch (error) {
    log.error('Could not enable the Referer ruleset', String(error));
    return false;
  }
}
