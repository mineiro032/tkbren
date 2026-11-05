// todas as rotas /api/* da loja rodam aqui
import { createApp } from '../../lib/app.mjs';
import { blobsStorage } from '../../lib/storage-blobs.mjs';

const handle = createApp({ storage: blobsStorage(), env: process.env });

export default (req) => handle(req);
export const config = { path: '/api/*' };
