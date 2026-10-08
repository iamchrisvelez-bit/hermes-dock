import { AuthService } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { Store } from '../store.ts';

// Creates a fresh one-time pairing code directly in the local database.
// Requires shell access to the Mac, which is what makes it an owner-only action.
const config = loadConfig();
const store = new Store(openDb(config.dbFile));
const { code, expiresAt } = new AuthService(store).createPairingCode('cli');
console.log(`One-time pairing code: ${code}`);
console.log(`Expires: ${expiresAt}`);
