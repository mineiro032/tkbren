// armazenamento no netlify blobs · banco = 1 json com etag (trava otimista), arquivos = 1 blob cada
import { getStore } from '@netlify/blobs';

export function blobsStorage(opts = {}) {
  const store = () => getStore({ name: 'loja', consistency: 'strong', ...opts });
  return {
    // version: null = ainda não existe · etag = trava · '' = sem etag (só no emulador local)
    async loadDb() {
      const s = store();
      const r = await s.getWithMetadata('db', { type: 'json' });
      if (!r) return null;
      const etag = r.etag || (await s.getMetadata('db'))?.etag || '';
      return { db: r.data, version: etag };
    },
    async saveDb(db, version) {
      const s = store();
      if (version === null) return (await s.setJSON('db', db, { onlyIfNew: true })).modified;
      if (!version) return (await s.setJSON('db', db)).modified;
      return (await s.setJSON('db', db, { onlyIfMatch: version })).modified;
    },
    async putFile(id, buf) { await store().set('file/' + id, new Blob([buf])); },
    async getFile(id) { const b = await store().get('file/' + id, { type: 'arrayBuffer' }); return b ? Buffer.from(b) : null; },
    async delFile(id) { await store().delete('file/' + id); },
  };
}
