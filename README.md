# loja · pix wiinpay

node 18+, zero dependências.

## rodar
```
cp .env.example .env     # coloque sua WIINPAY_API_KEY e o BASE_URL público
node server.js
```
sem `WIINPAY_API_KEY` a loja roda em **modo teste**: gera pix falso e mostra um botão "simular pagamento".

## fluxo
1. cliente monta o carrinho → preenche nome, e-mail, whatsapp (cpf opcional)
2. servidor cria o pedido e o pix na wiinpay (`POST /payment/create`)
3. cliente cai em `/pedido/ID?t=TOKEN` com **todos os dados da compra** + qr code + copia e cola
4. wiinpay chama `BASE_URL/api/webhook/wiinpay` → servidor confirma o status na api (`GET /payment/list/:id`) antes de marcar pago
5. a página do pedido atualiza sozinha e vira comprovante

## onde mexer
- produtos, estoque e pedidos: pelo painel `/admin` (`data/products.json` é só o catálogo inicial de exemplo)
- webhook precisa de url pública (vps, railway, render…) — localhost não recebe

## admin · estoque
- acesse `/admin` · senha em `ADMIN_PASSWORD` (no modo teste é `admin`)
- crie o produto e suba o estoque: **1 arquivo = 1 unidade** ou **1 linha de texto = 1 unidade** (login, chave, link…)
- a loja mostra quantas unidades restam e bloqueia quando esgota
- no checkout as unidades ficam **reservadas** por `RESERVE_MINUTES` (padrão 30) · não pagou, voltam pro estoque
- pagou → a unidade vira **entregue** e aparece só na página daquele pedido (download protegido pelo token do pedido)
- se alguém pagar depois do estoque acabar, o admin mostra "pago sem estoque"; ao subir unidades novas, elas vão primeiro pra esse pedido
- arquivos ficam em `data/files/` (fora da pasta pública) · banco em `data/db.json` — faça backup dessa pasta
