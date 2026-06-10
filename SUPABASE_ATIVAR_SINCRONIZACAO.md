# Ativar sincronizacao Supabase

O app ja esta preparado para sincronizar os 3 celulares pela mesma base.

Status em 10/06/2026: Supabase criado, chave publica configurada e SQL rodado.

## Projeto configurado

- Nome: `pedro-gas-agua-racao`
- Project ref: `bhviwfevchovntyfiahm`
- URL: `https://bhviwfevchovntyfiahm.supabase.co`
- Chave publica: configurada em `supabase-config.js`
- Tabela: `public.business_state`

## Como conferir

Depois de publicado:

1. Abra o app.
2. Entre como Dono.
3. Va em `Ajustes`.
4. O cartao `Nuvem` deve mostrar `Conectada`.
5. Toque em `Sincronizar agora`.

Os celulares que instalarem ou abrirem o app vao usar a mesma base de clientes,
produtos, vendas e estoque.

## Observacao de seguranca

Esta versao usa sincronizacao imediata para colocar o app para funcionar hoje.
Antes de dados mais sensiveis, a proxima etapa recomendada e mover as permissoes
para autenticacao real no backend.
