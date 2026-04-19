import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH    = path.join(__dirname, '..', 'platforms.config.json');
const PLATFORMS_PATH = path.join(__dirname, '..', 'platforms.json');

interface PlatformEntry {
  name: string;
  url: string;
  enabled?: boolean;
}

function loadConfig(): PlatformEntry[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return data.platforms || [];
  } catch (err) {
    logger.error({ err }, 'failed to parse platforms.config.json');
    return [];
  }
}

export class SyncService {
  private static platformsPath = PLATFORMS_PATH;

  static async syncFeeWallets() {
    const platforms = loadConfig();
    const enabled   = platforms.filter(p => p.enabled !== false);

    if (enabled.length === 0) {
      logger.warn('no enabled platforms in platforms.config.json — nothing to sync');
      return this.getLocalPlatforms();
    }

    logger.info({ count: enabled.length }, 'syncing platforms');
    const existing = this.getLocalPlatforms();
    const results: Record<string, string[]> = {};

    for (const { name, url } of enabled) {
      try {
        const response = await axios.get(url, { timeout: 10_000 });
        const content: string = response.data;

        const raw = content.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
        const addresses = [...new Set(
          raw.filter((a: string) => a.length >= 32 && a.length <= 44 && !a.includes('.') && !a.includes('/'))
        )];

        results[name] = addresses as string[];
        logger.info({ platform: name, addresses: addresses.length }, 'platform synced');
      } catch (err) {
        logger.error({ platform: name, err: (err as Error).message }, 'platform sync failed');
        if (existing[name]) results[name] = existing[name];
      }
    }

    if (Object.keys(results).length === 0) {
      logger.warn('all platform syncs failed — keeping existing platforms.json untouched');
      return existing;
    }

    fs.writeFileSync(this.platformsPath, JSON.stringify(results, null, 2));
    return results;
  }

  static getLocalPlatforms(): Record<string, string[]> {
    if (!fs.existsSync(this.platformsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.platformsPath, 'utf8'));
    } catch {
      return {};
    }
  }
}
