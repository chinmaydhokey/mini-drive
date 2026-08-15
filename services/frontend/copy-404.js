import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, 'dist', 'index.html');
const dist404 = path.join(__dirname, 'dist', '404.html');

if (fs.existsSync(distIndex)) {
  fs.copyFileSync(distIndex, dist404);
  console.log('✅ Created dist/404.html for SPA static hosting fallback.');
}
