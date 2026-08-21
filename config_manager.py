import os
import json
import ipaddress
import sys

CONFIG_FILE = '.discord_config'

# Значения по умолчанию. app_host / stun_host = 0.0.0.0 (bind all interfaces) —
# корректно для машин за NAT, где публичный IP не назначен ни на один интерфейс.
# server_ip — рекламный IP (для STUN URL и SAN сертификата).
DEFAULTS = {
    'server_ip': '0.0.0.0',
    'app_port': 5000,
    'stun_port': 3478,
    'app_host': '0.0.0.0',
    'stun_host': '0.0.0.0',
}

def get_local_ip():
    """Получить локальный IP адрес"""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None

def validate_ip(ip):
    """Проверить корректность IP адреса"""
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False

def _is_tty():
    """True если stdin интерактивный (не пайп / не systemd service)."""
    try:
        return bool(sys.stdin.isatty())
    except Exception:
        return False

def _build_config(server_ip, app_port, stun_port):
    """Собрать конфиг-словарь с bind-host = 0.0.0.0 и рекламным server_ip."""
    return {
        'server_ip': server_ip,
        'app_port': app_port,
        'stun_port': stun_port,
        # app_host / stun_host — это адрес для bind(). 0.0.0.0 = все интерфейсы.
        # Это безопасно и для локального запуска, и за NAT.
        'app_host': '0.0.0.0',
        'stun_host': '0.0.0.0',
    }

def _save_config(config):
    """Записать конфиг в файл."""
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=4)

def create_config():
    """Создать конфигурационный файл.

    Интерактивно (если stdin — TTY): запрашивает server_ip / app_port / stun_port.
    Неинтерактивно (пайп, systemd service, cron): использует defaults — НЕ зависает.
    """
    if not _is_tty():
        # Неинтерактивный режим: defaults, без input(), чтобы сервис мог стартовать.
        config = _build_config(
            server_ip=DEFAULTS['server_ip'],
            app_port=DEFAULTS['app_port'],
            stun_port=DEFAULTS['stun_port'],
        )
        _save_config(config)
        print("\n" + "=" * 60)
        print("ℹ️  stdin не TTY — конфигурация создана со значениями по умолчанию:")
        print(f"    server_ip={config['server_ip']}  app_port={config['app_port']}"
              f"  stun_port={config['stun_port']}")
        print(f"    app_host={config['app_host']}  stun_host={config['stun_host']}")
        print(f"    Отредактируйте {CONFIG_FILE} при необходимости и перезапустите сервис.")
        print("=" * 60 + "\n")
        return config

    # ── Интерактивный режим ────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("📝 ПЕРВИЧНАЯ НАСТРОЙКА ПРИЛОЖЕНИЯ")
    print("=" * 60)

    local_ip = get_local_ip()
    default_ip = local_ip if local_ip else DEFAULTS['server_ip']

    print(f"\nВаш локальный IP: {local_ip if local_ip else 'не определен'}")
    print("Для работы WebRTC звонков через интернет нужен внешний IP адрес сервера.")
    print("Если вы запускаете локально — используйте 127.0.0.1 или ваш локальный IP.")
    print("Если на сервере — укажите его внешний IP адрес.")
    print("server_ip — это РЕКЛАМНЫЙ адрес (для STUN URL и SAN сертификата).")
    print("Слушать сокеты приложение будет на 0.0.0.0 (все интерфейсы).\n")

    while True:
        try:
            server_ip = input(
                f"Введите IP адрес сервера [{default_ip}]: "
            ).strip()
        except EOFError:
            server_ip = ''
        if not server_ip:
            server_ip = default_ip
        if validate_ip(server_ip):
            break
        print("❌ Неверный IP адрес! Попробуйте снова.")

    print("\nНастройка портов (можно оставить значения по умолчанию):")

    while True:
        try:
            app_port_raw = input(f"Введите порт для веб-сервера [5000]: ").strip()
        except EOFError:
            app_port_raw = ''
        try:
            app_port = int(app_port_raw) if app_port_raw else 5000
        except ValueError:
            print("❌ Введите число!")
            continue
        if 400 <= app_port <= 65535:
            break
        print("❌ Порт должен быть от 400 до 65535")

    while True:
        try:
            stun_port_raw = input(f"Введите порт для STUN сервера [3478]: ").strip()
        except EOFError:
            stun_port_raw = ''
        try:
            stun_port = int(stun_port_raw) if stun_port_raw else 3478
        except ValueError:
            print("❌ Введите число!")
            continue
        if 1024 <= stun_port <= 65535:
            break
        print("❌ Порт должен быть от 1024 до 65535")

    config = _build_config(server_ip, app_port, stun_port)
    _save_config(config)

    print("\n" + "=" * 60)
    print("✅ Конфигурация сохранена в файл: .discord_config")
    print(f"   Сервер будет доступен по адресу: http://{server_ip}:{app_port}")
    print(f"   Для HTTPS: https://{server_ip}:{app_port}")
    print(f"   STUN сервер (рекламный URL): stun:{server_ip}:{stun_port}")
    print(f"   Bind: app_host=0.0.0.0  stun_host=0.0.0.0")
    print("=" * 60 + "\n")

    return config

def load_config():
    """Загрузить конфигурацию из файла.

    - Если файла нет — вызывает create_config() (TTY-aware).
    - Если файл есть — бэкфиллит отсутствующие ключи из DEFAULTS и сохраняет обратно,
      чтобы старые конфиги (без app_host/stun_host или без новых полей) продолжали работать.
    """
    if not os.path.exists(CONFIG_FILE):
        return create_config()

    try:
        with open(CONFIG_FILE, 'r') as f:
            config = json.load(f)
    except Exception as e:
        print(f"⚠️ Ошибка чтения конфигурации: {e}")
        print("Создаем новую конфигурацию...")
        return create_config()

    # Проверка обязательных полей (без них конфиг считаем «битым»).
    required = ['server_ip', 'app_port', 'stun_port']
    if not all(k in config for k in required):
        print("⚠️ Конфигурационный файл поврежден (нет обязательных полей). Создаем новый...")
        return create_config()

    # ── Бэкфилл отсутствующих полей ────────────────────────────────────────
    # Ключевой случай: старые конфиги без app_host / stun_host. Их нужно
    # выставить в 0.0.0.0, иначе за NAT bind на публичный IP упадёт с ошибкой.
    changed = False
    for key, default_value in DEFAULTS.items():
        if key not in config or config[key] in (None, ''):
            config[key] = default_value
            changed = True
            print(f"ℹ️  Бэкфилл отсутствующего поля «{key}» = {default_value!r}")

    # Подстраховка: если в старом конфиге app_host/stun_host были выставлены
    # в публичный IP (что ломает bind за NAT) — переписываем на 0.0.0.0 только
    # если этот IP не назначен на локальный интерфейс. Иначе оставляем как есть
    # (пользователь явно выбрал конкретный интерфейс).
    for host_key in ('app_host', 'stun_host'):
        cur = config.get(host_key)
        if cur and cur not in ('0.0.0.0', '127.0.0.1', '::', None):
            if not _ip_is_local(cur):
                print(f"ℹ️  {host_key}={cur!r} не назначен на локальный интерфейс "
                      f"— заменяю на 0.0.0.0 (bind all).")
                config[host_key] = '0.0.0.0'
                changed = True

    if changed:
        try:
            _save_config(config)
        except Exception as e:
            print(f"⚠️ Не удалось перезаписать конфиг после бэкфилла: {e}")

    return config

def _ip_is_local(ip):
    """True если IP назначен на какой-то локальный интерфейс."""
    try:
        import socket
        hostname = socket.gethostname()
        try:
            local_addrs = socket.getaddrinfo(hostname, None)
        except Exception:
            local_addrs = []
        candidates = {addr[4][0] for addr in local_addrs}
        # Добавим IP, привязанные к интерфейсам, через UDP-трюк
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            candidates.add(s.getsockname()[0])
            s.close()
        except Exception:
            pass
        return ip in candidates
    except Exception:
        return False

def save_config(config):
    """Публичный помощник для сохранения конфига (если понадобится извне)."""
    _save_config(config)
