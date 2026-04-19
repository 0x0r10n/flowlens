import { SyncService } from '../src/services/SyncService.js';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
  await SyncService.syncFeeWallets();
  process.exit(0);
})();
