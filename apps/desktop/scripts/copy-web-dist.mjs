import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceDir = path.resolve(root, '../web/dist');
const targetDir = path.resolve(root, 'dist/renderer');

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(targetDir, { recursive: true });
await fs.cp(sourceDir, targetDir, { recursive: true });

console.log(`Copied web assets from ${sourceDir} to ${targetDir}`);
