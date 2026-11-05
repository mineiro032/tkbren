// armazenamento em disco · usado rodando local (node server.mjs)
import fs from 'node:fs';
import path from 'node:path';

export function fileStorage(dir) {
  const DB = path.join(dir, 'db.json'), FILES = path.join(dir, 'files');
  fs.mkdirSync(FILES, { recursive: true });
  let version = 0; // em processo único basta um contador
  return {
    async loadDb() {
      if (!fs.existsSync(DB)) return null;
      return { db: JSON.parse(fs.readFileSync(DB, 'utf8')), version: String(version) };
    },
    async saveDb(db, v) {
      if (v === null ? fs.existsSync(DB) : v !== String(version)) return false;
      fs.writeFileSync(DB + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB + '.tmp', DB);
      version++; return true;
    },
    async putFile(id, buf) { fs.writeFileSync(path.join(FILES, id), buf); },
    async getFile(id) { const f = path.join(FILES, id); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async delFile(id) { fs.rmSync(path.join(FILES, id), { force: true }); },
  };
}
