# 🛒 Meu Mercado - App Web PWA

App Web Progressivo (PWA) para controle de compras no supermercado com total ao vivo, histórico de preços e funcionamento 100% offline.

## 🚀 Como Usar no Celular

Acesse o link direto pelo navegador do celular:
👉 **[https://sarayva.github.io/mercado/](https://sarayva.github.io/mercado/)**

Para instalar como app no celular:
- **Android (Chrome):** Toque nos 3 pontinhos e selecione *"Adicionar à tela inicial"* ou *"Instalar aplicativo"*.
- **iOS (Safari):** Toque no botão de compartilhar (ícone de quadrado com seta) e escolha *"Adicionar à Tela de Início"*.

## ✨ Funcionalidades da Fase 1 (MVP)
- **Total ao vivo:** O total é sempre calculado automaticamente pelo app ($\sum \text{qtdReal} \times \text{precoReal}$).
- **Modo "Comprando":** Interface pensada para uso com uma mão nos corredores, com divisão entre itens pendentes e no carrinho.
- **Header fixo:** Total atual, total estimado da lista e barra de progresso visual sempre visíveis.
- **Desfazer (Undo):** Qualquer ação pode ser revertida com um clique no botão "Desfazer".
- **Offline-First:** Funciona mesmo sem sinal de internet no mercado graças ao IndexedDB e Service Worker.
