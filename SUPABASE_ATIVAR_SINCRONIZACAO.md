# Ativar sincronizacao Supabase

O app ja esta preparado para sincronizar os 3 celulares pela mesma base.

## O que falta

1. Abrir o Supabase.
2. Entrar no projeto `pedro-gas-agua-racao`.
3. Abrir `Project Settings` > `API`.
4. Copiar a chave `anon public`.
5. Colar em `supabase-config.js`, no campo `anonKey`.
6. Abrir `SQL Editor`.
7. Rodar todo o conteudo de `supabase-schema.sql`.
8. Publicar os arquivos de novo no GitHub Pages.

## Como conferir

Depois de publicado:

1. Abra o app.
2. Entre como Dono.
3. Va em `Ajustes`.
4. O cartao `Nuvem` deve mostrar `Conectada`.
5. Toque em `Sincronizar agora`.

Quando isso estiver feito, os celulares que instalarem ou abrirem o app vao usar
a mesma base de clientes, produtos, vendas e estoque.

## Observacao de seguranca

Esta versao usa sincronizacao imediata para colocar o app para funcionar hoje.
Antes de dados mais sensiveis, a proxima etapa recomendada e mover as permissoes
para autenticacao real no backend.
