# Серверная часть (VPS)

TLS explicit proxy на **3proxy 0.9.9.1 LTS** (`3proxy/3proxy:lts-busybox`, закреплён по digest):
HTTPS-листенер 443 → CONNECT + Basic-auth, per-user ACL/лимиты, host-only логи, healthcheck.

Реализация соответствует ТЗ v1.1 §5.9 (SRV-1…12) и ADR-0001 §3. Отчёт спайка §3.1.1 —
[docs/server-spike-3.1.1.md](../docs/server-spike-3.1.1.md), эксплуатация — [docs/runbook-vps.md](../docs/runbook-vps.md).

## Быстрый старт

```bash
cd server
./scripts/init.sh                  # .env, etc/passwd, etc/user-limits.cfg, logs/, certs/
$EDITOR .env                       # PROXY_DOMAIN, LETSENCRYPT_EMAIL, PROXY_PUBLIC_IP
sudo ./scripts/issue-cert.sh       # Let's Encrypt standalone, порт 80 должен быть свободен
sudo ./scripts/add-user.sh alice   # пароль печатается один раз
docker compose up -d
./scripts/healthcheck.sh           # ok
```

Требования: Docker Engine + Compose v2, `openssl`, `python3` (для `CR:$3$`), `curl`.
`certbot` на хосте опционален — иначе используется закреплённый образ certbot.

## Состав

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | сервис proxy, pin digest, healthcheck, непривилегированный uid 1000 |
| `etc/3proxy.cfg` | TLS, auth strong, ACL, лимиты, формат логов |
| `etc/passwd` | `login:CR:$3$…`; создаётся `init.sh`, права 600, в git не попадает |
| `etc/user-limits.cfg` | per-user `connlim`/`bandlim*`; ведут скрипты пользователей |
| `scripts/3proxy-crypt.py` | `CR:$3$` BLAKE2b-crypt, байт-в-байт как `3proxy_crypt` |
| `scripts/add-user.sh` | пользователь + пароль ≥128 бит + опциональные лимиты |
| `scripts/rotate-user.sh` | новый пароль, старый перестаёт работать после restart |
| `scripts/revoke-user.sh`, `scripts/list-users.sh` | удаление и список логинов без хешей |
| `scripts/healthcheck.sh` | TLS + неавторизованный CONNECT должен вернуть 407 |
| `scripts/issue-cert.sh`, `renew-cert.sh`, `install-renew-cron.sh` | Let's Encrypt + autorenew |
| `scripts/smoke-test.sh` | SRV-AC-2…5, 7, 9, 10 на живом стенде |
| `scripts/init.sh` | идемпотентная подготовка каталога |

## Безопасность

- Наружу публикуется только `${PUBLIC_PORT:-443} → 3129`. Порт 3129 не публикуется.
- `auth strong`: анонимный/неверный CONNECT → `407`. Пароли — 128 бит, `CR:$3$` BLAKE2b;
  md5-crypt (`$1$`) запрещён и не принимается тестами.
- ACL сначала запрещает loopback/private/link-local/metadata/CGNAT и SMTP 25/465/587,
  затем разрешает только 80/443 и методы `CONNECT/GET/POST/HEAD/PUT/OTHER`.
- `PROXY_PUBLIC_IP` добавляет запрет CONNECT к самому прокси; `DENY_EXTRA_CIDRS` — свои диапазоны.
- Логи: `user`, `dst=host:port`, `method`, `status` (код результата 3proxy), `in/out`, `ms`.
  Путь/query, `Proxy-Authorization` и пароль не логируются. Ротация 7 дней, файлы 0600.
- Секреты и сертификаты не коммитятся: `.env`, `etc/passwd`, `certs/*` в `.gitignore`.

## Проверки

```bash
cd .. && npm run typecheck && npm run lint && npm run test
SMOKE_USER=alice SMOKE_PASSWORD=… server/scripts/smoke-test.sh
```

`tests/unit/server-config.test.ts` проверяет инварианты конфига, compose, скриптов и
известные векторы `CR:$3$`.
