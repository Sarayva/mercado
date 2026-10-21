# Changelog

Todas as alterações notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Adicionado
- **Suporte a Modo Claro e Modo Escuro**: Paleta de cores completa baseada nos tokens Fluent UI do projeto `csv-precifica-analytics`.
- **Botão Rápido de Alternância de Tema**: Ícone dinâmico (`☀️` / `🌙`) no topo do cabeçalho da barra superior para troca instantânea de tema.
- **Controle de Aparência nas Configurações**: Seção "Aparência & Tema" no modal de configurações para consulta do status e alternância de tema.
- **Prevenção de FOUC**: Script de pré-renderização no `<head>` para inicialização imediata do tema a partir do `localStorage` sem cintilação de tela.
- **Sincronização de Status Bar Mobile**: Atualização dinâmica da tag `<meta name="theme-color">` conforme o tema ativo (`#202020` no escuro e `#f3f3f3` no claro).

### Alterado
- Cache do Service Worker atualizado para `mercado-pwa-v22`.
- Tipografia unificada com fontes modernas do ecossistema Fluent (`'Segoe UI Variable Display', 'Segoe UI', Inter, system-ui`).
