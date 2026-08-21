#!/bin/bash

# Discord Clone — install.sh
# Однострочный установщик для сервера.
#
# Использование:
#   1) Через curl|bash (НЕинтерактивно — используются defaults / env vars):
#        curl -fsSL https://raw.githubusercontent.com/dm3tr-0/diskordik/main/install.sh | bash
#   2) Скачать и запустить (интерактивно, если запущено в TTY):
#        curl -fsSL https://raw.githubusercontent.com/dm3tr-0/diskordik/main/install.sh -o install.sh
#        bash install.sh
#
# Переменные окружения (необязательно, для полностью неинтерактивной установки):
#   SERVER_IP   — рекламный/внешний IP сервера (default: автоопределение через ifconfig.me)
#   APP_PORT    — порт веб-сервера (default: 5000)
#   STUN_PORT   — порт STUN сервера (default: 3478)
#   DISCORDIK_INSTALL_DIR — каталог установки (default: ./diskordik в текущей директории)

set -e  # Остановка при ошибке (но read-ы обёрнуты безопасно — см. ниже)

# ──────────────────────────────────────────────────────────────────────────────
# Цвета
# ──────────────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ──────────────────────────────────────────────────────────────────────────────
# Определяем режим: TTY (интерактивно) или пайп (неинтерактивно)
# ──────────────────────────────────────────────────────────────────────────────
if [ -t 0 ]; then
    INTERACTIVE=1
else
    INTERACTIVE=0
fi

# ──────────────────────────────────────────────────────────────────────────────
# Безопасный read: не падает с `set -e` при EOF (пайп / закрытый stdin)
# Возвращает значение в глобальной переменной READ_RESULT.
# ──────────────────────────────────────────────────────────────────────────────
safe_read() {
    local prompt="$1"
    local default="$2"
    local var
    if [ "$INTERACTIVE" -eq 1 ]; then
        echo -en "${YELLOW}${prompt}${NC}"
        # `read || true` защищает от ненулевого возврата на EOF
        read var || var=""
        if [ -z "$var" ]; then
            var="$default"
        fi
    else
        var="$default"
    fi
    READ_RESULT="$var"
}

# ──────────────────────────────────────────────────────────────────────────────
# Заголовок
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║     Discord Clone — Автоматическая установка на сервер   ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

if [ "$INTERACTIVE" -eq 0 ]; then
    echo -e "${YELLOW}⚠️  stdin не является TTY (вероятно, запуск через curl|bash).${NC}"
    echo -e "${YELLOW}   Интерактивные запросы отключены — используются значения по умолчанию${NC}"
    echo -e "${YELLOW}   или переменные окружения (SERVER_IP, APP_PORT, STUN_PORT).${NC}"
    echo -e "${YELLOW}   Для интерактивной установки: скачайте скрипт и запустите локально.${NC}"
    echo ""
fi

# ──────────────────────────────────────────────────────────────────────────────
# Глобальные переменные
# ──────────────────────────────────────────────────────────────────────────────
SERVER_IP=""
APP_PORT=""
STUN_PORT=""
INSTALL_DIR="${DISCORDIK_INSTALL_DIR:-$(pwd)/diskordik}"

# ──────────────────────────────────────────────────────────────────────────────
# Запрос IP адреса сервера
# ──────────────────────────────────────────────────────────────────────────────
get_server_ip() {
    local default_ip
    default_ip=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null \
                 || curl -fsS --max-time 3 icanhazip.com 2>/dev/null \
                 || curl -fsS --max-time 3 api.ipify.org 2>/dev/null \
                 || echo "0.0.0.0")
    default_ip="${default_ip//[$'\t\r\n ']/}"

    if [ -n "${SERVER_IP:-}" ]; then
        # Уже задано через env
        :
    elif [ "$INTERACTIVE" -eq 1 ]; then
        echo -e "${YELLOW}Определение IP адреса сервера...${NC}"
        echo -e "${GREEN}Внешний IP сервера: ${default_ip}${NC}"
        echo ""
        safe_read "Введите IP адрес для доступа к серверу (Enter для ${default_ip}): " "$default_ip"
        SERVER_IP="$READ_RESULT"
    else
        SERVER_IP="$default_ip"
    fi

    # Проверка формата IPv4
    if [[ $SERVER_IP =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        :
    else
        echo -e "${RED}Неверный формат IP адреса «${SERVER_IP}». Использую ${default_ip}${NC}" >&2
        SERVER_IP="$default_ip"
    fi
}

# ──────────────────────────────────────────────────────────────────────────────
# Запрос порта
# ──────────────────────────────────────────────────────────────────────────────
get_port() {
    local port_name="$1"
    local default_port="$2"
    local current_var="$3"   # имя глобальной переменной: APP_PORT или STUN_PORT

    # Если уже задано через env — выходим
    if [ -n "${!current_var:-}" ]; then
        return
    fi

    if [ "$INTERACTIVE" -eq 1 ]; then
        safe_read "Введите порт для ${port_name} (Enter для ${default_port}): " "$default_port"
        local port="$READ_RESULT"
    else
        local port="$default_port"
    fi

    if [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 400 ] && [ "$port" -le 65535 ]; then
        :
    else
        echo -e "${RED}Неверный порт «${port}». Использую ${default_port}${NC}" >&2
        port="$default_port"
    fi

    # Присваиваем в глобальную переменную
    if [ "$current_var" = "APP_PORT" ]; then
        APP_PORT="$port"
    elif [ "$current_var" = "STUN_PORT" ]; then
        STUN_PORT="$port"
    fi
}

# ──────────────────────────────────────────────────────────────────────────────
# Создание конфигурационного файла
# app_host / stun_host всегда 0.0.0.0 (bind all interfaces) — корректно для NAT.
# server_ip — рекламный IP (для STUN URL и SAN сертификата).
# ──────────────────────────────────────────────────────────────────────────────
create_config_file() {
    cat > .discord_config <<EOF
{
    "server_ip": "${SERVER_IP}",
    "app_port": ${APP_PORT},
    "stun_port": ${STUN_PORT},
    "stun_host": "0.0.0.0",
    "app_host": "0.0.0.0"
}
EOF
    echo -e "${GREEN}✅ Конфигурация сохранена в .discord_config${NC}"
}

# ──────────────────────────────────────────────────────────────────────────────
# Создание systemd сервиса
# ──────────────────────────────────────────────────────────────────────────────
create_systemd_service() {
    local service_name="discord-clone"
    local user
    user=$(whoami)
    local install_dir="$INSTALL_DIR"

    echo -e "${BLUE}Создание systemd сервиса...${NC}"

    sudo tee /etc/systemd/system/${service_name}.service > /dev/null <<EOF
[Unit]
Description=Discord Clone Messenger
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${install_dir}
Environment="PATH=${install_dir}/venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=${install_dir}/venv/bin/python ${install_dir}/app.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable ${service_name}.service > /dev/null 2>&1 || true

    echo -e "${GREEN}✅ Сервис создан и добавлен в автозагрузку${NC}"
}

# ──────────────────────────────────────────────────────────────────────────────
# [1/9] Обновление системы и установка зависимостей
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[1/9] Обновление системы и установка зависимостей...${NC}"
sudo apt update -qq
# libncurses5-dev удалён в Ubuntu 22.04+ → используем libncurses-dev.
# libncursesw5-dev здесь избыточен (libncurses-dev даёт и wide-char в новых Ubuntu).
sudo apt install -y -qq make build-essential libssl-dev zlib1g-dev libbz2-dev \
    libreadline-dev libsqlite3-dev wget curl llvm libncurses-dev \
    xz-utils tk-dev libffi-dev liblzma-dev git net-tools ufw \
    python3 python3-venv python3-dev ca-certificates 2>/dev/null

# ──────────────────────────────────────────────────────────────────────────────
# [2/9] Выбор Python: предпочтительно системный >= 3.9; иначе pyenv.
# ──────────────────────────────────────────────────────────────────────────────
PYTHON_BIN=""
USE_PYENV=0

if command -v python3 >/dev/null 2>&1; then
    SYS_PY_VER=""
    SYS_PY_VER=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
    SYS_PY_MAJOR=$(echo "$SYS_PY_VER" | cut -d. -f1)
    SYS_PY_MINOR=$(echo "$SYS_PY_VER" | cut -d. -f2)
    if [ "$SYS_PY_MAJOR" -gt 3 ] || { [ "$SYS_PY_MAJOR" -eq 3 ] && [ "$SYS_PY_MINOR" -ge 9 ]; }; then
        PYTHON_BIN="python3"
        echo -e "${GREEN}✅ Найден системный Python ${SYS_PY_VER} (≥3.9) — используем его.${NC}"
    fi
fi

if [ -z "$PYTHON_BIN" ]; then
    echo -e "${YELLOW}⚠️  Системный Python слишком старый или отсутствует — ставим через pyenv.${NC}"
    USE_PYENV=1

    echo -e "${BLUE}[2b/9] Установка pyenv...${NC}"
    if [ ! -d "$HOME/.pyenv" ]; then
        curl -fsSL https://pyenv.run | bash
    else
        echo -e "${GREEN}pyenv уже установлен — пропускаю.${NC}"
    fi

    export PYENV_ROOT="$HOME/.pyenv"
    export PATH="$PYENV_ROOT/bin:$PATH"
    eval "$(pyenv init --path)" 2>/dev/null || true
    eval "$(pyenv virtualenv-init -)" 2>/dev/null || true

    if ! grep -q "pyenv" ~/.bashrc 2>/dev/null; then
        {
            echo ''
            echo '# Pyenv configuration'
            echo 'export PYENV_ROOT="$HOME/.pyenv"'
            echo '[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"'
            echo 'eval "$(pyenv init -)"'
            echo 'eval "$(pyenv virtualenv-init -)"'
        } >> ~/.bashrc
    fi

    echo -e "${BLUE}[2c/9] Установка Python 3.10.14 через pyenv (компиляция ~5-10 мин)...${NC}"
    pyenv install -s 3.10.14
    pyenv global 3.10.14
    PYTHON_BIN="python"
fi

echo -e "${BLUE}Используем интерпретатор: ${PYTHON_BIN} ($(${PYTHON_BIN} --version 2>&1))${NC}"

# ──────────────────────────────────────────────────────────────────────────────
# [3/9] Клонирование / обновление репозитория
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[3/9] Клонирование репозитория...${NC}"
if [ ! -d "$INSTALL_DIR" ]; then
    git clone --quiet https://github.com/dm3tr-0/diskordik.git "$INSTALL_DIR"
else
    echo -e "${YELLOW}Каталог ${INSTALL_DIR} уже существует — делаем git pull...${NC}"
    git -C "$INSTALL_DIR" pull --quiet --ff-only || \
        echo -e "${YELLOW}⚠️  git pull не удался — продолжаем с существующей версией.${NC}"
fi
cd "$INSTALL_DIR"

# ──────────────────────────────────────────────────────────────────────────────
# [4/9] Виртуальное окружение
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[4/9] Настройка виртуального окружения...${NC}"
if [ ! -d "venv" ]; then
    "$PYTHON_BIN" -m venv venv
else
    echo -e "${GREEN}venv уже существует — переиспользуем.${NC}"
fi
# venv/bin/python — всегда использует тот интерпретатор, из которого создан.
source venv/bin/activate

# ──────────────────────────────────────────────────────────────────────────────
# [5/9] Установка Python пакетов
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[5/9] Установка Python пакетов...${NC}"
pip install --upgrade pip -q
if [ -f "requirements.txt" ]; then
    pip install -q -r requirements.txt
else
    echo -e "${YELLOW}⚠️ Файл requirements.txt не найден, устанавливаю базовые пакеты...${NC}"
    pip install -q flask flask-socketio eventlet python-engineio python-socketio
fi

# ──────────────────────────────────────────────────────────────────────────────
# [6/9] Настройка конфигурации
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[6/9] Настройка конфигурации...${NC}"
get_server_ip
get_port "веб-сервера" 5000 "APP_PORT"
get_port "STUN сервера" 3478 "STUN_PORT"

echo -e "${BLUE}   server_ip=${SERVER_IP}  app_port=${APP_PORT}  stun_port=${STUN_PORT}${NC}"
echo -e "${BLUE}   app_host=0.0.0.0  stun_host=0.0.0.0 (bind all interfaces)${NC}"

create_config_file

# ──────────────────────────────────────────────────────────────────────────────
# [7/9] Создание systemd сервиса
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[7/9] Создание systemd сервиса...${NC}"
create_systemd_service

# ──────────────────────────────────────────────────────────────────────────────
# [8/9] Запуск / перезапуск сервиса
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[8/9] Запуск сервиса...${NC}"
# restart безопасен и для первого запуска, и для переустановки
sudo systemctl restart discord-clone

# Проверка статуса
sleep 3
if sudo systemctl is-active --quiet discord-clone; then
    echo -e "${GREEN}✅ Сервис успешно запущен!${NC}"
else
    echo -e "${RED}⚠️ Возникли проблемы при запуске. Проверьте логи:${NC}"
    echo -e "${YELLOW}   sudo journalctl -u discord-clone -n 50${NC}"
fi

# ──────────────────────────────────────────────────────────────────────────────
# [9/9] Firewall
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${BLUE}[9/9] Открытие портов в firewall...${NC}"
sudo ufw allow ${APP_PORT}/tcp 2>/dev/null || true
sudo ufw allow ${STUN_PORT}/udp 2>/dev/null || true
echo -e "${GREEN}✅ Порты ${APP_PORT}/tcp и ${STUN_PORT}/udp открыты${NC}"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Финальный отчёт — значения берутся из фактически использованных переменных
# ──────────────────────────────────────────────────────────────────────────────
echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║                    УСТАНОВКА ЗАВЕРШЕНА!                  ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Информация:${NC}"
echo -e "   📍  IP: ${GREEN}${SERVER_IP}${NC}"
echo -e "   🌐 HTTP порт:    ${GREEN}${APP_PORT}${NC}"
echo -e "   🔌 STUN порт:    ${GREEN}${STUN_PORT}${NC}"
echo -e "   📁 Директория:   ${GREEN}${INSTALL_DIR}${NC}"
echo ""
echo -e "${BLUE}Доступные адреса:${NC}"
echo -e "   • ${GREEN}http://${SERVER_IP}:${APP_PORT}${NC}"
echo -e "   • (локально) ${GREEN}http://127.0.0.1:${APP_PORT}${NC}"
echo ""

echo -e "${BLUE}Управление сервисом:${NC}"
echo -e "   • Статус:    ${YELLOW}sudo systemctl status discord-clone${NC}"
echo -e "   • Запуск:    ${YELLOW}sudo systemctl start discord-clone${NC}"
echo -e "   • Останов:   ${YELLOW}sudo systemctl stop discord-clone${NC}"
echo -e "   • Логи:      ${YELLOW}sudo journalctl -u discord-clone -f${NC}"
echo -e "   • Перезапуск:${YELLOW}sudo systemctl restart discord-clone${NC}"
echo ""

echo -e "${GREEN}🎉 Установка завершена! Откройте в браузере: http://${SERVER_IP}:${APP_PORT}${NC}"
