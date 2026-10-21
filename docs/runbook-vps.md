# Runbook VPS

Эксплуатация серверной части Chrome VPS Tunnel: TLS explicit proxy на 3proxy 0.9.9 LTS.
Требования: ТЗ v1.1 §5.9 (SRV-1…12), ADR-0001 §3. Отчёт спайка: [server-spike-3.1.1.md](server-spike-3.1.1.md).

## 0. Что где лежит

```
server/
  docker-compose.yml      # один сервис proxy, 443 → 3129, uid 1000
  etc/3proxy.cfg          # TLS + auth + ACL + логи
  etc/passwd              # логины и CR:$3$ хеши (0600, не в git)
  etc/user-limits.cfg     # per-user connlim/bandlim (не в git)
  certs/                  # Let's Encrypt + симлинки fullchain.pem/privkey.pem
  logs/                   # 3proxy.log.YYYY.MM.DD, 0600, 7 дней
  scripts/                # init, users, certs, health, smoke
```

Наружу открыт только `${PUBLIC_PORT:-443}`. Порт `3129` живёт только внутри контейнера.
Для выпуска сертификата временно нужен `80/tcp`.

## 1. Установка с нуля

На чистом VPS (Ubuntu/Debian, root):

```bash
apt-get update && apt-get install -y docker.io docker-compose-v2 openssl python3 curl git
git clone https://github.com/archual/chrome-tunel-vps.git /opt/vps-tunnel
cd /opt/vps-tunnel/server
./scripts/init.sh
```

Заполните `.env`:

```dotenv
PROXY_DOMAIN=proxy.k1812.ru
LETSENCRYPT_EMAIL=admin@example.com
PROXY_PUBLIC_IP=203.0.113.10   # публичный IPv4 VPS
PUBLIC_PORT=443
```

Проверьте DNS: `dig +short proxy.k1812.ru` должен вернуть `PROXY_PUBLIC_IP`.
Откройте в firewall `80/tcp` (для ACME) и `443/tcp`; `3129` не открывайте.

```bash
sudo ./scripts/issue-cert.sh
sudo ./scripts/add-user.sh alice
docker compose up -d
./scripts/healthcheck.sh
```

Ожидаемо: `ok`. Если `healthcheck.sh` вернул ошибку — см. §6.

## 2. Сертификат Let's Encrypt (SRV-2)

Первый выпуск:

```bash
sudo ./scripts/issue-cert.sh
```

Скрипт использует host `certbot`, если он установлен, иначе закреплённый образ
`certbot/certbot:v5.8.0@sha256:f70a…`. Сертификат кладётся в `server/certs/live/<domain>/`,
а `server/certs/fullchain.pem` и `privkey.pem` — симлинки для 3proxy. Права:
`fullchain.pem` 644, `privkey.pem` 600, владелец uid/gid 1000 (пользователь контейнера).

Продление и autorenew:

```bash
sudo ./scripts/renew-cert.sh          # продлевает и перезапускает proxy только при изменении
sudo ./scripts/install-renew-cron.sh  # ежедневно в 03:00
```

3proxy читает сертификат при старте; после продления restart рвёт активные CONNECT на
несколько секунд. Cron стоит на 03:00 — окно минимума нагрузки.

Проверка цепочки:

```bash
openssl s_client -connect proxy.k1812.ru:443 -servername proxy.k1812.ru -CAfile /etc/ssl/certs/ca-certificates.crt </dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## 3. Пользователи и лимиты (SRV-4, SRV-6, SRV-9)

```bash
sudo ./scripts/add-user.sh alice
# login: alice
# password (shown once, store it now): <64 hex>

sudo ./scripts/add-user.sh bob --connlim 50 --bandwidth 8000000
sudo ./scripts/rotate-user.sh alice
sudo ./scripts/revoke-user.sh bob
./scripts/list-users.sh
```

- Пароль — `openssl rand -hex 16` (128 бит), печатается один раз и не хранится.
- Хеш — `CR:$3$<salt>$<hash>` (BLAKE2b-crypt). MD5-crypt (`$1$`) запрещён.
- `--connlim N` — максимум одновременных соединений (3proxy `connlim N 0 user * * *`).
- `--bandwidth BPS` — `bandlimin/bandlimout` для пользователя (бит/с, ≥300).
- Скрипты атомарно переписывают `etc/passwd`/`etc/user-limits.cfg` и перезапускают proxy.
- `SKIP_RESTART=1` — изменить файлы без перезапуска (для отладки).

Проверка входа (пароль подставьте свой):

```bash
curl -sS --proxy-cacert /etc/ssl/certs/ca-certificates.crt \
  -x https://alice:<password>@proxy.k1812.ru:443 https://api.ipify.org; echo
```

После ротации старый пароль обязан вернуть `407`, новый — `200`.

## 4. Healthcheck (SRV-8, SRV-AC-9)

```bash
./scripts/healthcheck.sh   # ok — TLS принят и неавторизованный CONNECT даёт 407
```

Внутри контейнера healthcheck делает то же через `ssl_client` (busybox) и проверяет 407.
Проверка вручную:

```bash
curl -sS --max-time 8 --proxy https://proxy.k1812.ru:443 \
  --resolve proxy.k1812.ru:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' http://example.com/
# 407
```

Если вернулось `200` — прокси открыт, немедленно остановите сервис и проверьте
`auth strong`/`users` в `etc/3proxy.cfg` и наличие `etc/passwd`.

## 5. Логи (SRV-7, SRV-AC-7)

```bash
docker compose logs --tail=100 proxy
tail -n 50 logs/3proxy.log.$(date +%Y.%m.%d)
```

Формат:

```
L2026-10-21T12:00:00+00:00 user=alice dst=api.ipify.org:443 method=CONNECT status=00000 in=4652 out=1881 ms=345
```

Есть `user`, `dst=host:port`, `method`, `status`, `in/out` байты, `ms`. Нет URL path/query,
`Proxy-Authorization` и пароля. `status` — код результата 3proxy: `00000` успех,
`00007`/`00012` авторизация (клиент видит 407), `00001`/`00011` отказ ACL (403/502),
`00002` превышение лимита (503). Для диагностики всегда смотрите код, который получил клиент.

Ротация: один файл в день, хранится 7 файлов (`rotate 7`). Права 0600, каталог 700.
Доступ к логам — только root/администратор.

## 6. Диагностика

| Симптом | Вероятная причина | Действие |
|---|---|---|
| `407` на верных кредах | нет пользователя/хеш повреждён/старый пароль | `list-users.sh`, `rotate-user.sh`, проверить `etc/passwd` |
| `407` у всех | `auth strong` не применён, proxy перезапущен без конфига | `docker compose logs`, `docker compose restart proxy` |
| `403` на внешний сайт | порт не 80/443 или цель в private/link-local | открыть 80/443; проверить ACL |
| `403` на `CONNECT host:443` | `DENY_EXTRA_CIDRS`/`PROXY_PUBLIC_IP` слишком широкие | сузить `.env`, restart |
| `503` | сработал `connlim` (лимит соединений) или policy | поднять `--connlim`, проверить логи |
| TLS ошибка клиента | сертификат просрочен/подменён/не тот домен | `renew-cert.sh`, `openssl s_client` |
| контейнер unhealthy | порт 3129 не слушается/нет сертификата | `docker compose logs`, проверить `certs/fullchain.pem` |
| `entrypoint: ... missing` | не выполнен `init.sh`/`issue-cert.sh` | выполнить шаг и `docker compose up -d` |

Диагностика с клиента:

```bash
curl -v -x https://alice:<password>@proxy.k1812.ru:443 https://example.com/ -o /dev/null
curl -v -x https://alice:<password>@proxy.k1812.ru:443 --proxytunnel http://127.0.0.1:80/ -o /dev/null
```

## 7. Бэкап и восстановление

Бэкапить: `server/.env`, `server/etc/passwd`, `server/etc/user-limits.cfg`,
`server/certs/` (или выпустить сертификат заново). `logs/` — по желанию.

```bash
sudo tar --create --file /root/vps-tunnel-$(date +%F).tar.gz \
  --directory /opt/vps-tunnel server/.env server/etc/passwd \
  server/etc/user-limits.cfg server/certs
```

Восстановление: распаковать, `chmod 600 etc/passwd .env`, `chmod 700 certs`, проверить
владельца сертификатов (uid 1000), затем `docker compose up -d` и `healthcheck.sh`.

## 8. Обновление образа

1. Проверить новый digest `3proxy/3proxy:lts-busybox` и прогнать спайк/смоук на тестовом стенде.
2. Обновить `image:` в `docker-compose.yml` (digest, не `latest`).
3. `docker compose pull && docker compose up -d`; проверить `healthcheck.sh` и `smoke-test.sh`.
4. При откате вернуть прежний digest и `docker compose up -d`.

## 9. Приёмка SRV-AC на тестовом стенде

`server/scripts/smoke-test.sh` автоматизирует AC-2…5, 7, 9, 10:

```bash
cd /opt/vps-tunnel
SMOKE_USER=alice SMOKE_PASSWORD='<password>' PROXY_PUBLIC_IP=203.0.113.10 \
  server/scripts/smoke-test.sh
```

| AC | Проверка |
|---|---|
| SRV-AC-1 | `dig +short proxy.k1812.ru`, `openssl s_client` (в T10/Flux) |
| SRV-AC-2 | smoke: anonymous CONNECT → 407 |
| SRV-AC-3 | smoke: wrong password → 407 |
| SRV-AC-4 | smoke: valid CONNECT → 200, exit IP = PROXY_PUBLIC_IP |
| SRV-AC-5 | smoke: 25, private, metadata, 8080 → 403 |
| SRV-AC-6 | `add-user.sh` → вход; `rotate-user.sh` → новый работает, старый 407 |
| SRV-AC-7 | smoke: в логах есть user/host/method/status/bytes, нет секретов/path/query |
| SRV-AC-8 | `add-user.sh --connlim 2`, 3-й одновременный CONNECT → 503, сервис жив |
| SRV-AC-9 | `healthcheck.sh` → ok; `docker compose stop proxy` → ошибка |
| SRV-AC-10 | smoke: `git grep` + `git check-ignore` для `.env`, `etc/passwd`, `certs/*` |
