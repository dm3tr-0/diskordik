# diskordik

Self-hosted мессенджер в стиле Discord: текстовые сообщения с E2E-шифрованием, голосовые звонки и демонстрация экрана через WebRTC.

> **Стек:** Python 3.10+ · Flask · Flask-SocketIO · SQLAlchemy/SQLite · WebRTC · vanilla JS + Web Crypto API

---

## Содержание

1. [Архитектура](#1-архитектура)
2. [Структура проекта](#2-структура-проекта)
3. [Бэкенд (Python)](#3-бэкенд-python)
4. [Фронтенд (JS / HTML / CSS)](#4-фронтенд-js--html--css)
5. [E2E-шифрование](#5-e2e-шифрование)
6. [Доставка сообщений и кэш](#6-доставка-сообщений-и-кэш)
7. [Звонки и демонстрация экрана (WebRTC)](#7-звонки-и-демонстрация-экрана-webrtc)
8. [Установка и запуск](#8-установка-и-запуск)
9. [Конфигурация](#9-конфигурация)
10. [Безопасность](#10-безопасность)
11. [Ограничения и планы](#11-ограничения-и-планы)

---

## 1. Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                      Браузер (клиент)                     │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ UI (HTML │  │ E2E      │  │ MsgCache │  │ WebRTC  │ │
│  │ + CSS +  │  │ (crypto) │  │(localSt.)│  │ (call)  │ │
│  │ icons.js)│  │          │  │          │  │         │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │             │              │      │
│       └──────────────┴─── Socket.IO ─┴────────────┘      │
│                          (HTTPS/WSS)                     │
└──────────────────────────────┬──────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────┐
│                     Сервер (Flask)                       │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ HTTP     │  │ Socket.IO    │  │ STUN-сервер      │  │
│  │ routes   │  │ (сигналинг,  │  │ (WebRTC NAT)     │  │
│  │ (auth,   │  │ события)     │  │                  │  │
│  │ keys)    │  │              │  │                  │  │
│  └────┬─────┘  └──────┬───────┘  └──────────────────┘  │
│       │               │                                 │
│       └───────┬───────┘                                 │
│          ┌────┴─────┐                                   │
│          │ SQLite   │  (только недоставленные сообщения) │
│          │ (users,  │                                   │
│          │ friends, │                                   │
│          │ msgs)    │                                   │
│          └──────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

**Ключевые принципы:**
- **Сервер не видит содержимого сообщений** — только шифртекст. Ключи живут в браузерах.
- **Сообщения не хранятся на сервере после доставки** — online-сообщения идут через in-memory буфер, офлайн-сообщения удаляются после доставки.
- **Звонки P2P** — медиа-трафик идёт напрямую между браузерами (WebRTC), сервер только передаёт сигнальные данные (SDP/ICE).
- **STUN-сервер** — встроенный, помогает браузерам определить свои публичные адреса для NAT traversal.

---

## 2. Структура проекта

```
diskordik/
├── app.py                 # Главный файл: Flask-приложение, маршруты, Socket.IO обработчики
├── models.py              # SQLAlchemy-модели: User, FriendRequest, Message, Call
├── config_manager.py      # Конфигурация (.discord_config), TTY-aware интерактивная настройка
├── stun.py                # Собственный STUN-сервер (RFC 5389) для WebRTC
├── install.sh             # Автоматический установщик для Linux-сервера
├── requirements.txt       # Python-зависимости
├── README.md              # Краткое описание
├── Documentation.md       # Этот файл
│
├── templates/             # Jinja2-шаблоны
│   ├── base.html          # Базовый каркас: flash, звуки, модалки, JS-инициализация
│   ├── index.html         # Дашборд: сайдбар + чат + вся логика сообщений
│   ├── login.html         # Страница входа
│   └── register.html      # Страница регистрации
│
├── static/                # Статика (отдаётся Flask)
│   ├── style.css          # Полный CSS (тёмная тема Discord, адаптив)
│   ├── socket.js          # Инициализация Socket.IO-соединения
│   ├── e2e.js             # E2E-шифрование: ECDH + AES-GCM (Web Crypto)
│   ├── message-cache.js   # Локальный кэш переписки (localStorage)
│   ├── icons.js           # SVG-иконки в стиле Lucide
│   ├── call.js            # WebRTC-логика: звонки, mute, демонстрация экрана
│   └── sounds/            # WAV-звуки уведомлений
│       ├── incoming-call.wav
│       └── new-message.wav
│
└── (генерируется при запуске)
    ├── instance/discord.db   # SQLite база данных
    ├── .discord_config       # JSON-конфигурация
    ├── cert.pem / key.pem    # SSL-сертификат (самоподписанный)
    └── venv/                 # Виртуальное окружение Python
```

---

## 3. Бэкенд (Python)

### `app.py` — главный модуль (~840 строк)

**Импорт и monkey-patching:**
```python
import eventlet
eventlet.monkey_patch()  # обязателен для Socket.IO + eventlet
```

**Глобальные структуры для доставки сообщений:**
```python
ONLINE_USERS = {}    # user_id -> set(socket_id)  — активные сессии
PENDING_BUFFER = {}  # uuid -> message_dict       — in-memory буфер для online-доставки
```

**Маршруты HTTP:**

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/` | GET | Редирект на `/login` или `/dashboard` |
| `/register` | GET/POST | Регистрация пользователя |
| `/login` | GET/POST | Вход |
| `/logout` | GET | Выход |
| `/dashboard` | GET | Главная страница (требует auth) |
| `/get_messages/<user_id>` | GET | Недоставленные сообщения с собеседником |
| `/get_friends_list` | GET | Список друзей (без превью — E2E) |
| `/get_friend_requests` | GET | Входящие заявки в друзья |
| `/search_users?q=` | GET | Поиск пользователей |
| `/send_friend_request/<id>` | POST | Отправить заявку |
| `/accept_friend_request/<id>` | POST | Принять заявку |
| `/reject_friend_request/<id>` | POST | Отклонить заявку |
| `/api/keys/me` | GET | Свой публичный ключ |
| `/api/keys/upload` | POST | Загрузить свой публичный ключ |
| `/api/keys/<user_id>` | GET | Чужой публичный ключ |

**Socket.IO обработчики:**

| Событие | Направление | Описание |
|---------|-------------|----------|
| `connect` | клиент→сервер | Регистрация сессии, доставка pending-сообщений |
| `disconnect` | клиент→сервер | Снятие сессии, flush буфера в БД если последняя сессия |
| `send_message` | клиент→сервер | Отправка шифртекста (online→буфер, offline→БД) |
| `new_message` | сервер→клиент | Доставка сообщения получателю + эхо отправителю |
| `pending_messages` | сервер→клиент | Пакет сообщений при подключении |
| `message_received` | клиент→сервер | Подтверждение доставки → удаление с сервера |
| `message_delivered` | сервер→клиент | Уведомление отправителя о доставке |
| `typing` | клиент→сервер | Индикатор печати |
| `user_typing` | сервер→клиент | Передача индикатора собеседнику |
| `user_status` | сервер→клиент | Онлайн/офлайн статус (broadcast) |
| `call_user` | клиент→сервер | Инициация звонка |
| `incoming_call` | сервер→клиент | Уведомление о входящем звонке |
| `accept_call` / `reject_call` / `end_call` | клиент→сервер | Управление звонком |
| `webrtc_offer` / `webrtc_answer` / `webrtc_ice_candidate` | клиент→сервер→клиент | WebRTC-сигналинг |
| `screen_share_started` / `screen_share_stopped` | клиент→сервер→клиент | Демонстрация экрана |

**Лёгкая миграция:**
При старте `run_lightweight_migrations()` добавляет колонки `public_key`, `uuid`, `iv` к существующим таблицам (для старых БД).

### `models.py` — модели данных (~125 строк)

```python
class User(UserMixin, db.Model):
    id, username, password_hash, is_online, last_seen
    public_key    # JWK (JSON) — публикуется на сервере для E2E
    friends       # many-to-many через user_friends
    sent_requests, received_requests  # FriendRequest
    sent_messages, received_messages   # Message
    calls_made, calls_received        # Call

class FriendRequest(db.Model):
    id, from_user_id, to_user_id, status ('pending'/'accepted'/'rejected'), created_at

class Message(db.Model):
    id, uuid       # уникальный ID (для буфера и БД)
    content        # ШИФРТЕКСТ (base64)
    iv             # base64 nonce для AES-GCM
    sender_id, receiver_id, timestamp, is_read
    # ВНИМАНИЕ: после доставки (message_received) строка УДАЛЯЕТСЯ

class Call(db.Model):
    id, caller_id, receiver_id, call_type ('audio'), status ('ringing'/'active'/'ended'/'rejected')
    started_at, ended_at, created_at
```

### `config_manager.py` — конфигурация (~235 строк)

- `CONFIG_FILE = '.discord_config'` — JSON с ключами `server_ip`, `app_port`, `stun_port`, `app_host`, `stun_host`.
- `create_config()` — интерактивная настройка (TTY-aware: если не TTY — использует defaults).
- `load_config()` — загрузка с backfill отсутствующих ключей (совместимость со старыми конфигами).
- **Важно:** `app_host`/`stun_host` = `0.0.0.0` (bind all), `server_ip` = рекламный IP (для STUN URL и SAN сертификата).

### `stun.py` — STUN-сервер (~125 строк)

Простая реализация STUN Binding Request/Response (RFC 5389):
- Слушает UDP на `stun_host:stun_port`.
- На Binding Request отвечает XOR-MAPPED-ADDRESS с публичным IP клиента.
- Безопасный bind: при ошибке (порт занят / нет прав) — логирует предупреждение и выходит, не роняя приложение.

---

## 4. Фронтенд (JS / HTML / CSS)

### `templates/base.html` — базовый каркас

- Подключает скрипты: `socket.io` (CDN), `socket.js`, `icons.js`, `e2e.js`, `message-cache.js`, `call.js`.
- Глобальные элементы: flash-сообщения, аудио-элементы (звуки), overlay для мобильного меню, модалка выхода, модалка входящего звонка.
- Inline-JS: система звуков (`playSound`, `toggleSound`), функции `openMobileSidebar`/`closeMobileSidebar`, `showLogoutModal`.
- Передаёт в window: `STUN_URL`, `currentUsername`, `currentUserId`.

### `templates/index.html` — дашборд (~820 строк)

**HTML-структура сайдбара (Discord-style):**
```
.dashboard-sidebar
  ├── .sidebar-header          # «💬 Прямые сообщения» + кнопка поиска
  ├── .sidebar-search           # поиск пользователей
  ├── .sidebar-scroll           # прокручиваемая середина
  │     ├── #friendRequests    # заявки в друзья
  │     └── #friendsList       # DM-список
  └── .user-panel               # нижняя панель: аватар + mute/deafen/sound
```

**Inline-JS (основные функции):**
- `setupSocketListeners()` — обработка `new_message`, `pending_messages`, `message_delivered`, `user_typing`, `user_status`.
- `handleIncomingMessage(data, isPending)` — расшифровка, кэш, отображение, подтверждение доставки.
- `sendMessage()` — шифрование + отправка через `socket.emit('send_message', ...)`.
- `openChat(friendId, username)` / `closeChat()` — управление активным чатом.
- `loadFriendsList()` / `loadFriendRequests()` — загрузка списков (с учётом typing-индикатора).
- `updateTypingInDM(friendId, isTyping)` — индикатор «печатает...» в строке DM.
- `initE2E()` — генерация/публикация ключей при входе.

### `static/e2e.js` — сквозное шифрование (~175 строк)

См. [раздел 5](#5-e2e-шифрование).

### `static/message-cache.js` — локальный кэш (~45 строк)

```javascript
window.MsgCache = {
    add(friendId, msg),      // добавить сообщение (дедуп по id)
    getAll(friendId),        // все сообщения с другом (последние 500)
    last(friendId),          // последнее сообщение (для превью в DM)
    clear(friendId)
};
// Хранение: localStorage, ключ "diskordik_msgs_<friendId>"
```

### `static/icons.js` — SVG-иконки (~55 строк)

Набор иконок в стиле Lucide (stroke=currentColor): `mic`, `micOff`, `headphones`, `headphonesOff`, `bell`, `bellOff`, `search`, `phone`, `phoneOff`, `send`, `x`, `chevronLeft`, `menu`, `monitor`, `lock`, `message`, `users`, `check`, `settings`.

Использование:
```html
<button data-icon="mic" data-size="20"></button>
```
`window.applyIcons()` заполняет все `[data-icon]` при загрузке DOM.

### `static/call.js` — WebRTC-логика (~1475 строк)

Основные функции:
- `startCall(type)` — запрос `getUserMedia({audio:true})`, создание `RTCPeerConnection`, сигнал `call_user`.
- `createGlobalPeerConnection()` — настройка `onicecandidate`, `ontrack`, добавление треков.
- `createAndSendOffer()` / `handleRemoteOffer(data)` — обмен SDP.
- `toggleMute()` / `toggleSpeaker()` — управление аудио-треками + SVG-иконки.
- `startScreenShare()` / `stopScreenShare()` — `getDisplayMedia()`, замена видеотрека в `RTCRtpSender`.
- `showDiscordCallPanel()` — нижняя плавающая панель звонка (SVG-иконки, индикатор пинга).
- `showScreenShareInChat(senderName)` — встроенный фрейм демонстрации с LIVE-индикатором.
- Адаптивное качество (60-120 FPS), измерение пинга через `getStats()`.

### `static/style.css` — стили (~2480 строк)

CSS-переменные (палитра Discord):
```css
--bg-sidebar: #2b2d31;    --bg-main: #313338;     --bg-input: #383a40;
--bg-hover: #35373c;      --bg-active: #404249;   --bg-floating: #111214;
--text-normal: #dbdee1;   --text-header: #f2f3f5; --text-muted: #949ba4;
--brand: #5865f2;         --green: #23a55a;       --red: #da373c;
--border: #3f4147;
```

Ключевые секции: auth, sidebar (header/scroll/user-panel), chat (header/messages/input), call modal/widget/panel, screen share, volume menu, mobile (@media max-width:768px).

---

## 5. E2E-шифрование

### Схема

```
Alice (браузер)                      Bob (браузер)
┌─────────────────┐                  ┌─────────────────┐
│ privat_key_A    │                  │ privat_key_B    │
│ (localStorage)  │                  │ (localStorage)  │
│ public_key_A ───┼── сервер ────────┼── public_key_B  │
└────────┬────────┘                  └────────┬────────┘
         │                                    │
         └──── ECDH(P-256) ───────────────────┘
                    │
                    ▼
           shared_secret (32 байта)
                    │
                    ▼ (deriveKey)
           AES-GCM-256 ключ
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
   encrypt(plaintext)     decrypt(ciphertext)
   + random IV (12 байт)  IV передаётся открыто
```

### Реализация (`static/e2e.js`)

```javascript
// Генерация пары ECDH P-256
const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
);

// Экспорт публичного ключа в JWK → публикация на сервере
const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);

// Согласование общего ключа + деривация в AES-GCM-256
const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,                  // не экспортируемый
    ['encrypt', 'decrypt']
);

// Шифрование
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);
// Передаём: { ciphertext: base64, iv: base64 }
```

### Что видит сервер

Сервер видит **только**:
- `content` — base64 шифртекст (непонятный набор байтов)
- `iv` — base64 nonce (открытый, но бесполезный без ключа)
- `sender_id`, `receiver_id`, `timestamp`

Сервер **не может** расшифровать сообщения — у него нет приватных ключей (они только в браузерах).

### Приватный ключ

Хранится в `localStorage` браузера по ключу `diskordik_keys`:
```json
{ "<user_id>": { "priv": <JWK>, "pub": <JWK> } }
```
- При первом входе `ensureMyKey()` генерирует пару и публикует публичный ключ на сервере.
- Приватный ключ **никогда** не покидает браузер.
- **Важно:** очистка localStorage = потеря возможности расшифровать старые сообщения. Рекомендуется экспорт/импорт ключей (не реализовано, см. планы).

### Совместимость

Если `crypto.subtle` недоступен (HTTP без localhost — небезопасный контекст), включается режим совместимости: сообщения ходят открытым текстом, в UI показывается предупреждение. Для E2E нужен HTTPS.

---

## 6. Доставка сообщений и кэш

### Сценарий 1: получатель онлайн

```
Alice ──send_message(шифртекст)──► Сервер
                                      │
                                      ├─ PENDING_BUFFER[uuid] = msg  (только в RAM!)
                                      ├─ emit new_message → Alice (эхо)
                                      └─ emit new_message → Bob (доставка)
                                            │
Bob ◄──new_message───────────────────────────┘
Bob ──message_received(uuid)──► Сервер
                                   ├─ PENDING_BUFFER.pop(uuid)  (удалено из RAM)
                                   └─ emit message_delivered → Alice
```
**В БД ничего не пишется.** Сообщение существует на сервере только в RAM между отправкой и подтверждением.

### Сценарий 2: получатель офлайн

```
Alice ──send_message(шифртекст)──► Сервер
                                      │
                                      ├─ INSERT INTO message (uuid, content, iv, ...)  ← БД
                                      └─ emit new_message → Alice (эхо)

[Bob подключается позже]

Bob ──connect──► Сервер
                   ├─ SELECT * FROM message WHERE receiver_id = Bob
                   └─ emit pending_messages → Bob
Bob ──message_received(uuid)──► Сервер
                                   └─ DELETE FROM message WHERE uuid = ...  ← удалено
```

### Сценарий 3: получатель был онлайн, но ушёл до подтверждения

При `disconnect` последней сессии получателя — `PENDING_BUFFER` сбрасывается в БД (flush), чтобы сообщения не потерялись.

### Кэш на устройстве

История переписки хранится в `localStorage` через `message-cache.js`:
- После доставки и расшифровки сообщение сохраняется в кэш.
- При открытии чата история загружается из кэша (на сервере её уже нет).
- Лимит: 500 сообщений на собеседника.
- Превью последнего сообщения в списке DM берётся из кэша (сервер превью не отдаёт — он не может расшифровать).

---

## 7. Звонки и демонстрация экрана (WebRTC)

### Поток звонка

```
Alice                              Сервер (сигналинг)               Bob
  │                                   │                              │
  ├─ call_user ──────────────────────►│                              │
  │  (getUserMedia audio)             ├─ incoming_call ─────────────►│
  │                                   │                              │
  │                                   │◄─ accept_call ───────────────┤
  │◄─ call_accepted ──────────────────┤                              │
  │                                   │                              │
  ├─ webrtc_offer (SDP) ─────────────►│── webrtc_offer ─────────────►│
  │                                   │◄─ webrtc_answer (SDP) ───────┤
  │◄─ webrtc_answer ──────────────────┤                              │
  │                                   │                              │
  ├─ webrtc_ice_candidate ───────────►│── webrtc_ice_candidate ─────►│
  │◄─ webrtc_ice_candidate ───────────┤◄─ webrtc_ice_candidate ──────┤
  │                                   │                              │
  │ ════════ прямой P2P аудио-поток ═════════════════════════════════ │
  │  (DTLS/SRTP шифрование, через сервер НЕ идёт)                     │
```

**Сервер участвует только в сигналинге** (передача SDP и ICE). Медиа-трафик идёт напрямую P2P между браузерами.

### Демонстрация экрана

- `navigator.mediaDevices.getDisplayMedia()` — захват экрана.
- Видеотрек добавляется в существующий `RTCPeerConnection` через `RTCRtpSender.replaceTrack()`.
- Сигналы `screen_share_started` / `screen_share_stopped` уведомляют собеседника.
- На стороне получателя — встроенный фрейм с LIVE-индикатором, регулятором громкости и индикатором качества (FPS, битрейт, пинг).

### Шифрование звонков

WebRTC **не использует** E2E-шифрование на основе публичных ключей (как сообщения). Вместо этого:

- **DTLS** — шифрует сигнальный канал между браузерами (ключи renegotiated per session).
- **SRTP** — шифрует медиа-трафик (аудио/видео) с ключами, согласованными через DTLS.

Это **транспортное** шифрование (server не видит медиа, т.к. трафик P2P), но **не end-to-end** в том же смысле, что сообщения:
- Сообщения: только отправитель и получатель могут расшифровать (ключи в браузерах).
- Звонки: браузеры шифруют трафик, но ключи согласуются динамически и не привязаны к identity-ключам пользователей.

Подробнее в ответе на вопрос пользователя ниже.

---

## 8. Установка и запуск

### Быстрый запуск (локально)

```bash
cd diskordik
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# HTTPS (нужен для WebRTC и E2E):
python app.py
# Сертификат сгенерируется автоматически, открой https://127.0.0.1:5000

# HTTP за reverse-proxy (E2E не будет — нужен безопасный контекст):
DISCORDIK_NO_HTTPS=1 python app.py
```

### Установка на сервер (Linux)

```bash
curl -sSL https://raw.githubusercontent.com/dm3tr-0/diskordik/main/install.sh | bash
```

Или интерактивно:
```bash
git clone https://github.com/dm3tr-0/diskordik.git
cd diskordik
bash install.sh
```

`install.sh` создаёт systemd-сервис `discord-clone`, открывает порты в ufw.

### Windows

```bash
git clone https://github.com/dm3tr-0/diskordik.git
cd diskordik
py -3.10 -m venv venv
venv/Scripts/Activate.ps1
pip install -r requirements.txt
python app.py
```

---

## 9. Конфигурация

Файл `.discord_config` (JSON):

```json
{
    "server_ip": "203.0.113.10",
    "app_port": 5000,
    "stun_port": 3478,
    "stun_host": "0.0.0.0",
    "app_host": "0.0.0.0"
}
```

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `server_ip` | Рекламный IP (для STUN URL и SAN сертификата) | автоопределение |
| `app_port` | Порт Flask-приложения | 5000 |
| `stun_port` | Порт STUN-сервера (UDP) | 3478 |
| `app_host` | Адрес bind для Flask | `0.0.0.0` |
| `stun_host` | Адрес bind для STUN | `0.0.0.0` |

**Переменные окружения:**

| Переменная | Описание |
|------------|----------|
| `DISCORDIK_NO_HTTPS=1` | Запуск в HTTP (за reverse-proxy, без автогенерации сертификата) |
| `DISCORDIK_SECRET_KEY` | Секретный ключ Flask (иначе default) |

---

## 10. Безопасность

### Что защищено

- ✅ **Сообщения E2E** — сервер видит только шифртекст, ключи в браузерах.
- ✅ **Приватные ключи** — не покидают браузер (localStorage).
- ✅ **Доставка** — сообщения не хранятся на сервере после доставки.
- ✅ **Пароли** — `werkzeug.security.generate_password_hash` (pbkdf2).
- ✅ **WebRTC-медиа** — DTLS/SRTP шифрование, P2P трафик.

### Что НЕ защищено (ограничения)

- ⚠️ **Метаданные** — сервер видит кто, кому и когда отправил сообщение (но не содержимое).
- ⚠️ **Звонки** — транспортное шифрование (DTLS/SRTP), но не E2E на identity-ключах.
- ⚠️ **Публичные ключи** — сервер хранит их открыто. Атака: подмена ключа при первой публикации (нет верификации fingerprint). Рекомендуется добавить проверку fingerprint между пользователями (trust on first use).
- ⚠️ **Приватный ключ в localStorage** — доступен XSS-атаке. Для production нужен более надёжный storage (IndexedDB + WebCrypto non-extractable, или аппаратный ключ).
- ⚠️ **STUN без TURN** — за симметричным NAT звонки не пройдут (нужен TURN-релий).

---

## 11. Ограничения и планы

### Текущие ограничения

- Только 1:1 чаты и звонки (нет групп).
- Нет video-звонков (только аудио + демонстрация экрана).
- Нет экспорта/импорта ключей (смена устройства = потеря истории).
- Нет push-уведомлений (только вкладка браузера).
- STUN без TURN (симметричный NAT не поддерживается).

### Идеи для развития

- Групповые чаты: `Channel` / `GroupMember` модели, сервер реле шифртекста по списку участников.
- Групповые звонки: mesh P2P (до 5-6 человек) или SFU (см. ответ ниже).
- Video-звонки: `getUserMedia({video:true})`, уже есть инфраструктура для видеотреков.
- Проверка fingerprint ключей (QR-код / ручной ввод).
- TURN-сервер (coturn) для NAT traversal.
- Push-уведомления через Web Push API.

---

## Приложение: ответы на вопросы

### Q: Звонки шифруются так же как сообщения?

**Нет.** Сообщения и звонки используют разные схемы шифрования:

| | Сообщения | Звонки |
|---|-----------|--------|
| **Тип** | End-to-End (E2E) | Транспортное (DTLS/SRTP) |
| **Ключи** | ECDH P-256, привязаны к identity пользователей (в localStorage) | Динамические, renegotiated per call |
| **Сервер видит** | Только шифртекст | Не видит медиа (P2P), но видит сигналинг (SDP, ICE) |
| **Кто может расшифровать** | Только отправитель + получатель | Любой участник DTLS-handshake |

**Почему так:** WebRTC использует встроенные DTLS/SRTP для шифрования медиа — это стандарт и работает «из коробки». Но эти ключи не привязаны к identity-ключам пользователей (ECDH из E2E-сообщений). Чтобы сделать звонки настоящим E2E (как в Signal), нужно внедрить **Double Ratchet** или **SFrame** — это значительная работа, которая пока не реализована.

**Практический вывод:** для 1:1 звонков DTLS/SRTP достаточно — медиа идёт P2P, сервер его не видит. Для групповых звонков через SFU ситуация меняется (см. ниже).

### Q: Как сделать групповые чаты/звонки на слабом VPS (1 ядро, 1 ГБ RAM)?

#### Групповые чаты (текст)

Реализуется легко и дёшево для сервера:

1. **Модели:** `Group` (id, name), `GroupMember` (group_id, user_id).
2. **Отправка:** клиент шифрует сообщение **N раз** — отдельный шифртекст для каждого участника группы (на их публичные ключи). Сервер хранит N копий шифртекста до доставки каждому.
3. **Альтернатива (дешевле):** один общий симметричный ключ группы (рассылается каждому участнику, зашифрованный на их публичных ключах). Сообщение шифруется один раз. Минус: при выходе участника нужно менять ключ (rekeying).
4. **Нагрузка на сервер:** минимальная — реле шифртекста, как сейчас. 1 ядро / 1 ГБ легко держит сотни активных групп.

#### Групповые звонки (5-10 человек)

Это сложнее. Три архитектурных варианта:

**Вариант A: Mesh (P2P, каждый-с-каждым)**
- Каждый участник соединяется напрямую с каждым другим.
- Сервер участвует только в сигналинге.
- **Плюс:** нулевая нагрузка на сервер (медиа идёт мимо).
- **Минус:** N² соединений. Для 5 человек = 20 связей, для 10 = 45. Браузеры начинают задыхаться (CPU + bandwidth).
- **Лимит:** ~5-6 человек, дальше качество падает.
- **Для 1 ядро/1 ГБ:** идеальный вариант — сервер почти не нагружается.

**Вариант B: SFU (Selective Forwarding Unit)**
- Один сервер получает потоки от всех и релеит каждому только нужные.
- **Плюс:** масштабируется до 30-50 человек, браузеры не перегружены.
- **Минус:** сервер несёт всю медиа-нагрузку. Нужно CPU (транскодинг) + bandwidth (N × bitrate).
- **На 1 ядро/1 ГБ:** тяжело. Opus (аудио) ещё потянет ~10 человек, но video + screen share — нет.
- **Готовые SFU:** mediasoup, Janus, LiveKit, Pion. Pion (Go) — самый лёгкий, можно развернуть рядом.

**Вариант C: MCU (микшер)**
- Сервер микширует все потоки в один и рассылает.
- **Плюс:** минимальная нагрузка на клиентов (1 входящий поток).
- **Минус:** максимальная нагрузка на сервер (декодинг + микширование + кодирование).
- **На 1 ядро/1 ГБ:** нереально для video.

#### Рекомендация для слабого VPS

1. **До 5-6 человек:** Mesh P2P. Сервер только сигналинг (как сейчас). Реализовать проще всего — обобщить текущий 1:1-звонок на N участников: при `call_user` создать N `RTCPeerConnection`, сигналинг через существующий Socket.IO.
2. **7-15 человек:** поднять **Pion-SFU** (отдельный процесс, Go, ~50 МБ RAM) рядом с diskordik. diskordik делегирует ему медиа-реле, сам занимается только сигналингом и E2E-ключами.
3. **Больше 15:** отдельный сервер под SFU, diskordik на 1 ГБ VPS только координирует.

**Для аудио-только** (без видео) mesh P2P может вытянуть и 10 человек — Opus кодек лёгкий (~24 kbps на поток). Но демонстрация экрана (video) в mesh на 10 человек = 90 видеопотоков — браузер не справится.

**Итог:** начните с mesh P2P для групп до 6 человек (минимальные изменения кода, нулевая нагрузка на VPS). Когда понадобится больше — поднимите Pion-SFU как мини-сервис рядом.
