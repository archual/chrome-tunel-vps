# chrome-tunel-vps

Chrome-расширение Manifest V3 «VPS Tunnel»: маршрутизация трафика браузера через аутентифицированный HTTPS-прокси на собственном VPS. Плюс поставляемая серверная часть (Docker + 3proxy) и документация.

> Статус: T1 Foundations — каркас репозитория, сборка и zip. Функциональность туннеля появляется в следующих задачах.

## Требования

- Node.js 20+
- npm 10+
- Chrome stable 120+

## Быстрый старт

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run package
```

`npm run build` собирает расширение в `dist/`, `npm run package` — в `dist/vps-tunnel-<version>.zip`.

## Установка расширения (load unpacked)

1. Выполните `npm run build`.
2. Откройте `chrome://extensions`, включите «Режим разработчика».
3. Нажмите «Загрузить распакованное расширение» и выберите папку `dist/`.

## Структура

```
extension/   MV3-расширение: manifest, service worker, popup, options
server/      серверная часть (Docker + 3proxy), появится в отдельной задаче
scripts/     сборка и упаковка расширения
docs/        ADR, runbook VPS, инструкция владельцу
tests/       Vitest unit-тесты
```

## Документация

- [ТЗ (ARC-587)](https://pape.k1812.ru/ARC/issues/ARC-587#document-tech-spec)
- [ADR-0001: архитектура](docs/adr/0001-chrome-vps-tunnel.md)
- [Инструкция владельцу](docs/owner-quickstart.md)
- [Runbook VPS](docs/runbook-vps.md)
- [Безопасность](SECURITY.md)

## Проверки

Набор проверок из «Быстрого старта» запускается локально на Node.js 20. GitHub Actions пока не подключён — по решению владельца репозитория CI обходимся без workflow.
