# Спайк ADR-0001 §3.1.1 — 3proxy LTS, TLS, CONNECT, ACL, `CR:$3$`

- **Дата:** 21.10.2026
- **Задача:** ARC-603 (T5, серверная часть)
- **Владельцы:** Forge (спайк/конфиг), Flux (demo-стенд и внешний DNS/TLS)
- **Статус:** пройден; gate для серверной реализации снят
- **Вход:** ADR-0001 D5/D6, §2.2, §3.1–3.6, §3.1.1; ТЗ v1.1 §5.9, §10.2

## 1. Версии и образ

| Компонент | Значение |
|---|---|
| 3proxy (эталонный бинарь Debian 0.9.9) | `3proxy tiny proxy server 3proxy-0.9.9 ()` |
| 3proxy в образе `3proxy/3proxy:lts-busybox` | `3proxy tiny proxy server 3proxy-0.9.9.1 (261010165717)` |
| Digest образа (multi-arch index) | `sha256:a7058c40fe315777cc44daeea2da7dba16a85eb857ccb1852cd329514ce4c74a` |
| amd64 manifest | `sha256:0d4f1dc3d192ae20a5e2bae0f103a881c5ad8092a49aca479280fe819c377caa` |
| OpenSSL клиента (проверка TLS) | OpenSSL 3.5.7 (9 Jun 2026) |

`3proxy -v` из образа:

```text
3proxy tiny proxy server 3proxy-0.9.9.1 (261010165717)
(c)3APA3A, Vladimir Dubrovin & 3proxy.org
Documentation and sources: https://3proxy.org/
```

Образ **не содержит** `3proxy_crypt` (в образе только `/bin/3proxy`). Поэтому
`server/scripts/3proxy-crypt.py` реализует тот же BLAKE2b-crypt и проверяется
векторами эталонного `3proxy_crypt` из 0.9.9 (см. §3, п. 4).

## 2. Стенд и честные ограничения

Спайк выполнялся в изолированной среде агента, где нет Docker и нет доступа к
demo-VPS/публичному DNS. Проверка сделана на **официальном бинаре 3proxy 0.9.9**,
на **бинаре 3proxy-0.9.9.1 из целевого образа** (запущен через musl loader) и на
**точном `server/etc/3proxy.cfg`** из репозитория (пути заменены на временный
каталог, `-i0.0.0.0` → `-i127.0.0.1`, TLS-порт 3129 вместо публикации 443).
Результаты TLS/CONNECT/ACL/407/403 на обоих бинарях совпадают.
Сертификат — локальный CA с SAN `proxy.k1812.ru`, добавленный в доверие клиента:
это доказывает, что TLS-листенер отдаёт валидную для имени цепочку и клиент
подключается **без `-k`**. Публичный LE-сертификат и `proxy.k1812.ru:443`
(SRV-AC-1) проверяются на demo-стенде Flux в T10 — они не влияют на выводы
о `ssl_serv`/CONNECT/ACL/`CR:$3$`.

**Compose:** `docker compose v5.6.1 config` для `server/docker-compose.yml` +
`server/.env.example` завершился `rc=0`; проверены digest образа, публикация
только `443→3129`, `user`, `cap_drop`, read-only mounts и healthcheck. Скрипты
контейнера проверены busybox ash из целевого образа: `sh -n` для `entrypoint.sh`
и `healthcheck-container.sh`, рендер ACL (`PROXY_PUBLIC_IP`/`DENY_EXTRA_CIDRS`),
healthcheck против живого TLS-прокси (`rc=0`). **Запуск самого контейнера в
песочнице агента невозможен — нет Docker daemon.** `docker compose up -d` +
`smoke-test.sh` на demo-стенде выполняет Flux/QA (T10); для этого в репозитории
есть готовый `server/scripts/smoke-test.sh`.

## 3. Пять пунктов §3.1.1

### П. 1 — `3proxy -v`, `ssl_serv`, TLS ≥ 1.2, сертификат без `-k`

```bash
openssl s_client -connect 127.0.0.1:3129 -servername proxy.k1812.ru \
  -CAfile ca.pem -tls1_2 </dev/null
# New, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
# Verify return code: 0 (ok)

openssl s_client -connect 127.0.0.1:3129 -servername proxy.k1812.ru \
  -CAfile ca.pem -tls1_3 </dev/null
# New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
# Verify return code: 0 (ok)
```

В конфиге: `ssl_server_min_proto_version TLSv1.2`, `ssl_serv` перед `proxy -p3129`,
`ssl_noserv` после. Клиент без CA отвергается (`unknown ca` в логе 3proxy), с CA —
`Verify return code: 0 (ok)`, то есть `-k` не нужен.

### П. 2 — CONNECT: 200/exit IP, 407 без/с неверными кредами, 403 на чужие порты

```text
anonymous CONNECT              -> response 407
wrong password                 -> http=407
valid creds, api.ipify.org:443 -> http=200, exit IP 95.24.0.180
direct egress (--noproxy '*')  -> 95.24.0.180  (совпадает)
example.com:25                 -> response 403
127.0.0.1:80                   -> response 403
169.254.169.254:80             -> response 403
example.com:8080               -> response 403
```

Exit IP совпал с прямым egress-IP стенда; на VPS это будет публичный IP VPS
(SRV-AC-4).

### П. 3 — `auth strong`, per-user ACL, `connlim`, host-only лог

`auth strong` + `users $/etc/3proxy/passwd`; ACL: private/link-local/metadata/CGNAT,
IPv6 `::1`/`::ffff:0:0/96`/`fc00::/7`/`fe80::/10` и SMTP 25/465/587 запрещены
**до** `allow` для 80/443 и методов `HTTP_CONNECT/GET/POST/HEAD/PUT/OTHER`.

Per-user лимит (две параллельные CONNECT-сессии разрешены, третья):

```text
user-limits.cfg: connlim 2 0 spikeuser * * *
hold 1  HTTP/1.0 200 Connection established
hold 2  HTTP/1.0 200 Connection established
third   HTTP/1.0 503 Service Unavailable
```

Сервис после 503 продолжает обслуживать соединения. Лог (файл, 0600):

```text
2026-10-21T09:37:54+0000 user=spikeuser dst=example.com:80 method=GET status=00000 in=858 out=184 ms=78
2026-10-21T09:37:54+0000 user=spikeuser dst=api.ipify.org:443 method=CONNECT status=00000 in=4650 out=1881 ms=319
2026-10-21T09:37:53+0000 user=- dst=example.com:443 method=CONNECT status=00004 in=0 out=0 ms=8
2026-10-21T09:37:54+0000 user=spikeuser dst=example.com:25 method=CONNECT status=00001 in=0 out=0 ms=7
```

Есть `user`, `dst=host:port`, `method`, `status`, `in/out`, `ms`. GET с
`/some/secret/path?token=SECRET123` дал строку `method=GET` без path/query.
Проверки: нет пароля, `Proxy-Authorization`, `http(s)://`, `?`.

`status` — код результата 3proxy (не HTTP-статус): `00000` успех, `00001` отказ ACL
(клиент видит 403), `00004`/`00007` авторизация (клиент видит 407), `00002` лимит
(клиент видит 503). Runbook §5 содержит расшифровку.

### П. 4 — `3proxy_crypt` → `CR:$3$`, вход с хешем

Эталон:

```bash
3proxy_crypt testsalt testpass
# CR:$3$testsalt$rLpPSsFiEZbWom3uj3E.40

3proxy_crypt abcdefgh12345678 spikeuserpass123
# CR:$3$abcdefgh12345678$dm1YsEIvPs2Z280yw3fmv0
```

`server/scripts/3proxy-crypt.py` выдаёт **байт-в-байт** те же строки (векторы
закреплены в `--self-test` и в unit-тестах). Пользователь, добавленный скриптом
(`CR:$3$`), успешно авторизуется; вход с паролем после ротации:

```text
old password after rotation -> http=407
new password after rotation -> http=200, exit IP 95.24.0.180
```

MD5-crypt (`$1$`) не используется и не принимается тестами.

### П. 5 — админ/http выключены, 3129 не наружу, анонимный CONNECT не создаёт туннель

- В конфиге нет `admin`, `http`, SOCKS-сервисов; включён только `proxy` с TLS.
- `docker-compose.yml` публикует только `${PUBLIC_PORT:-443}:3129/tcp`; порт 3129
  не имеет отдельного `ports`-маппинга и недоступен снаружи.
- Анонимный CONNECT возвращает 407 и туннель не устанавливается (проверено curl и
  `ssl_client` в контейнерном healthcheck).

## 4. Найденные ограничения и решения

| Наблюдение | Решение в репозитории |
|---|---|
| В busybox-образе нет `3proxy_crypt` | `3proxy-crypt.py` (BLAKE2b, те же векторы); add/rotate используют его |
| `%T` для plain HTTP содержит весь request line (path/query) | `logformat ... method=%1-1T`: только первый токен (метод) |
| `daemon` из ADR-скелета не подходит для Docker | `daemon` не используется; 3proxy работает foreground под entrypoint |
| `connlim` без полного ACL-хвоста трактуется неявно | явный вид: `connlim 100 0 * * * *`, per-user: `connlim N 0 user * * *` |
| Пустой `passwd` — parse error и контейнер не стартует | `revoke-user.sh` оставляет locked `__disabled__` с случайным потерянным паролем |
| `ssl_serv` в busybox-сборке проверен | старт с `ssl_serv` и TLS 1.2/1.3 подтверждён |
| IPv4-only egress и mapped-адреса | `::ffff:0:0/96` в deny; IPv6-цель не создаёт туннель (502), IPv4-ACL не обходится |

## 5. Как воспроизвести

1. На VPS выполнить [runbook](runbook-vps.md) §1–2 (init, `.env`, LE-сертификат).
2. `docker compose up -d`; `./scripts/healthcheck.sh` → `ok`.
3. `SMOKE_USER=alice SMOKE_PASSWORD='…' PROXY_PUBLIC_IP=<IP> ./scripts/smoke-test.sh`.
4. Повторить команды §3 настоящего отчёта против `proxy.k1812.ru:443`
   (для TLS — `openssl s_client` с системным CA, без `-k`).
5. `docker compose up -d` и `docker compose ps` → `healthy`; это единственный шаг,
   который не выполнялся в песочнице агента из-за отсутствия Docker daemon.

Локальная проверка без VPS (как выполнялся спайк): запустить официальный бинарь
3proxy 0.9.9 с `server/etc/3proxy.cfg`, заменив пути на временный каталог и
указав TLS-порт 3129; TLS-сертификат — локальный CA с SAN `proxy.k1812.ru`.
Полный набор команд и фактический вывод — в этом документе; автотесты конфига:
`npm test -- tests/unit/server-config.test.ts tests/unit/server-scripts.test.ts`.

## 6. Вывод

Все пять пунктов §3.1.1 воспроизведены. `ssl_serv` + CONNECT + `auth strong` + ACL +
`CR:$3$` работают на 3proxy 0.9.9 LTS, включая бинарь 0.9.9.1 из закреплённого
образа (TLS 1.2/1.3, valid CONNECT, 407/403). Squid-fallback не требуется. Остаточная
внешняя проверка — публичный DNS/LE-сертификат и demo-стенд (Flux, T10, SRV-AC-1).
