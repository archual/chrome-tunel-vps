# ADR-0001: Chrome VPS Tunnel — архитектура

Каноническая версия ADR-0001 v1.0 ведётся в Paperclip: [ARC-588, документ `adr`](https://pape.k1812.ru/ARC/issues/ARC-588#document-adr). Исходное ТЗ: [ARC-587, `tech-spec` v1.1](https://pape.k1812.ru/ARC/issues/ARC-587#document-tech-spec).

Настоящий файл — заглушка для структуры репозитория (ADR §8). Полный текст ADR будет синхронизирован в `docs/adr/0001-chrome-vps-tunnel.md` отдельной задачей документации.

Ключевые решения, на которые опирается каркас:

- Manifest V3, Chrome ≥ 120, permissions: `proxy`, `storage`, `webRequest`, `webRequestAuthProvider`, `contextMenus`; `host_permissions: ["<all_urls>"]`; без `tabs`.
- Vite multi-entry: service worker, popup, options.
- TypeScript strict, Vitest, ESLint.
- Сборка в `dist/`, zip `dist/vps-tunnel-<version>.zip` с `manifest.json` в корне.
