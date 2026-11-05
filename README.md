# loja · pix wiinpay · estoque por unidade

roda no **netlify**: páginas em `public/`, backend em `netlify/functions/api.mjs`, banco e arquivos no **netlify blobs** (nada fica no git).

## variáveis de ambiente (netlify → site configuration → environment variables)
| nome | obrigatório | o que é |
|---|---|---|
| `WIINPAY_API_KEY` | sim | chave da wiinpay · sem ela o checkout fica desligado |
| `ADMIN_PASSWORD` | sim | senha do painel `/admin` |
| `BASE_URL` | não | ex: `https://tudocerto.casa` (usado no webhook · padrão = domínio do acesso) |
| `RESERVE_MINUTES` | não | quanto tempo a unidade fica reservada num pix não pago (padrão 30) |
| `MAX_FILE_MB` | não | tamanho máx. de cada arquivo do estoque (padrão 4 · limite das functions) |

depois de criar/alterar variável: **deploys → trigger deploy**.

## fluxo
1. cliente monta o carrinho → nome, e-mail, whatsapp (cpf opcional)
2. a unidade do estoque é **reservada** e o pix é gerado na wiinpay
3. cliente cai em `/pedido/ID?t=TOKEN` com os dados da compra + qr + copia e cola
4. wiinpay chama `/api/webhook/wiinpay` → o servidor confirma na api antes de marcar pago
5. pago → a unidade vira **entregue** e aparece só na página daquele pedido (download protegido pelo token)

## admin (`/admin`)
- crie o produto e suba o estoque: **1 arquivo = 1 unidade** ou **1 linha de texto = 1 unidade**
- cada unidade vai pra um único cliente · a loja mostra o estoque e bloqueia quando esgota
- reserva não paga volta pro estoque sozinha
- pagou sem estoque (reserva expirou e acabou)? aparece como "pago sem estoque"; a próxima unidade que você subir vai pra ele
- trava otimista no banco: duas compras simultâneas nunca levam a mesma unidade

## rodar local
```
npm install
node server.mjs      # modo teste: pix simulado, senha do admin = admin
```
