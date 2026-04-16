import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH   = path.join(__dirname, '..', 'platforms.config.json');
const PLATFORMS_PATH = path.join(__dirname, '..', 'platforms.json');

function loadConfig(): Record<string, string> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export class SyncService {
  private static platformsPath = PLATFORMS_PATH;

  static async syncFeeWallets() {
    const urls = loadConfig();
    if (Object.keys(urls).length === 0) {
      console.warn('⚠️  platforms.config.json is empty — nothing to sync.');
      return {};
    }

    console.log(`🔄 Syncing ${Object.keys(urls).length} platforms from platforms.config.json...`);
    const results: Record<string, string[]> = {};

    for (const [name, url] of Object.entries(urls)) {
      try {
        const response = await axios.get(url, { timeout: 10_000 });
        const content: string = response.data;

        // Solana addresses: base58, 32–44 chars, no dots or slashes
        const raw = content.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
        const addresses = [...new Set(
          raw.filter((a: string) => a.length >= 32 && a.length <= 44 && !a.includes('.') && !a.includes('/'))
        )];

        results[name] = addresses as string[];
        console.log(`   ✅ [${name}] ${addresses.length} addresses`);
      } catch (err) {
        console.error(`   ❌ [${name}] sync failed:`, (err as Error).message);
        // Keep existing wallet list for this platform if sync fails
        const existing = this.getLocalPlatforms();
        if (existing[name]) results[name] = existing[name];
      }
    }

    fs.writeFileSync(this.platformsPath, JSON.stringify(results, null, 2));
    return results;
  }

  static getLocalPlatforms(): Record<string, string[]> {
    if (!fs.existsSync(this.platformsPath)) return {};
    return JSON.parse(fs.readFileSync(this.platformsPath, 'utf8'));
  }
}
