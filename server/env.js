// Loads private settings from .env.local. Import this before anything that reads them.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
