#!/bin/bash

# Discord Clone - Однострочный установщик для сервера
# Использование: curl -sSL https://raw.githubusercontent.com/dm3tr-0/diskordik/main/install.sh | bash

set -e  # Остановка при ошибке

# Глобальные переменные
SERVER_IP=""
APP_PORT=""
STUN_PORT=""

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║     Discord Clone - Автоматическая установка на сервер   ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Функция для запроса IP адреса
get_server_ip() {
    local default_ip=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || curl -s --max-time 3 icanhazip.com 2>/dev/null || echo "0.0.0.0")
    
    echo -e "${YELLOW}Определение IP адреса сервера...${NC}"
    echo -e "${GREEN}Внешний IP сервера: ${default_ip}${NC}"
    echo ""
    read -p "$(echo -e ${YELLOW}Введите IP адрес для доступа к серверу (Enter для ${default_ip}): ${NC})" ip
    
    if [ -z "$ip" ]; then
        ip=$default_ip
    fi
    
    # Проверка формата IP
    if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        echo "$ip"
    else
        echo -e "${RED}Неверный формат IP адреса. Использую $default_ip${NC}" >&2
        echo "$default_ip"
    fi
}

# Функция для запроса порта
get_port() {
    local port_name=$1
    local default_port=$2
    local port
    
    read -p "$(echo -e ${YELLOW}Введите порт для $port_name (Enter для $default_port): ${NC})" port
    
    if [ -z "$port" ]; then
        port=$default_port
    fi
    
    # Проверка порта
    if [[ $port =~ ^[0-9]+$ ]] && [ $port -ge 1024 ] && [ $port -le 65535 ]; then
        echo "$port"
    else
        echo -e "${RED}Неверный порт. Использую $default_port${NC}" >&2
        echo "$default_port"
    fi
}

# Функция создания systemd сервиса
create_systemd_service() {
    local service_name="discord-clone"
    local user=$(whoami)
    local install_dir=$(pwd)
    
    echo -e "${BLUE}Создание systemd сервиса...${NC}"
    
    sudo tee /etc/systemd/system/${service_name}.service > /dev/null << EOF
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
    sudo systemctl enable ${service_name}.service > /dev/null 2>&1
    
    echo -e "${GREEN}✅ Сервис создан и добавлен в автозагрузку${NC}"
}

# Функция создания конфигурационного файла
create_config_file() {
    cat > .discord_config << EOF
{
    "server_ip": "${SERVER_IP}",
    "app_port": ${APP_PORT},
    "stun_port": ${STUN_PORT},
    "stun_host": "${SERVER_IP}",
    "app_host": "${SERVER_IP}"
}
EOF
    
    echo -e "${GREEN}✅ Конфигурация сохранена в .discord_config${NC}"
}

# Основной процесс установки
echo -e "${BLUE}[1/8] Обновление системы и установка зависимостей...${NC}"
sudo apt update -qq
sudo apt install -y -qq make build-essential libssl-dev zlib1g-dev libbz2-dev \
    libreadline-dev libsqlite3-dev wget curl llvm libncurses5-dev \
    libncursesw5-dev xz-utils tk-dev libffi-dev liblzma-dev git net-tools ufw

echo -e "${BLUE}[2/8] Установка pyenv...${NC}"
if [ ! -d "$HOME/.pyenv" ]; then
    curl -s https://pyenv.run | bash
fi

export PATH="$HOME/.pyenv/bin:$PATH"
eval "$(pyenv init --path)" 2>/dev/null
eval "$(pyenv virtualenv-init -)" 2>/dev/null

if ! grep -q "pyenv" ~/.bashrc; then
    echo 'export PATH="$HOME/.pyenv/bin:$PATH"' >> ~/.bashrc
    echo 'eval "$(pyenv init --path)"' >> ~/.bashrc
    echo 'eval "$(pyenv virtualenv-init -)"' >> ~/.bashrc
fi

echo -e "${BLUE}[3/8] Установка Python 3.10.14...${NC}"
pyenv install -s 3.10.14
pyenv global 3.10.14

echo -e "${BLUE}[4/8] Клонирование репозитория...${NC}"
if [ ! -d "diskordik" ]; then
    git clone --quiet https://github.com/dm3tr-0/diskordik.git
fi
cd diskordik

echo -e "${BLUE}[5/8] Настройка виртуального окружения...${NC}"
if [ ! -d "venv" ]; then
    python -m venv venv
fi
source venv/bin/activate

echo -e "${BLUE}[6/8] Установка Python пакетов...${NC}"
pip install --upgrade pip -q
pip install -q -r requirements.txt

echo -e "${BLUE}[7/8] Настройка конфигурации...${NC}"
# Запрос параметров у пользователя (сохраняем в глобальные переменные)
SERVER_IP=$(get_server_ip)
APP_PORT=$(get_port "веб-сервера" 5000)
STUN_PORT=$(get_port "STUN сервера" 3478)

create_config_file

echo -e "${BLUE}[8/8] Создание systemd сервиса...${NC}"
create_systemd_service

# Запуск сервиса
echo -e "${BLUE}Запуск сервиса...${NC}"
sudo systemctl start discord-clone

# Проверка статуса
sleep 3
if sudo systemctl is-active --quiet discord-clone; then
    echo -e "${GREEN}✅ Сервис успешно запущен!${NC}"
else
    echo -e "${RED}⚠️ Возникли проблемы при запуске. Проверьте логи:${NC}"
    echo -e "${YELLOW}   sudo journalctl -u discord-clone -n 50${NC}"
fi

# Вывод информации
echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║                    УСТАНОВКА ЗАВЕРШЕНА!                  ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Информация:${NC}"
echo -e "   📍 IP адрес: ${GREEN}${SERVER_IP}${NC}"
echo -e "   🌐 HTTP порт: ${GREEN}${APP_PORT}${NC}"
echo -e "   🔌 STUN порт: ${GREEN}${STUN_PORT}${NC}"
echo -e "   📁 Директория: ${GREEN}$(pwd)${NC}"
echo ""
echo -e "${BLUE}Доступные адреса:${NC}"
echo -e "   • ${GREEN}http://${SERVER_IP}:${APP_PORT}${NC}"
echo ""

echo -e "${BLUE}Управление сервисом:${NC}"
echo -e "   • Статус:   ${YELLOW}sudo systemctl status discord-clone${NC}"
echo -e "   • Запуск:   ${YELLOW}sudo systemctl start discord-clone${NC}"
echo -e "   • Останов:  ${YELLOW}sudo systemctl stop discord-clone${NC}"
echo -e "   • Логи:     ${YELLOW}sudo journalctl -u discord-clone -f${NC}"
echo -e "   • Перезапуск: ${YELLOW}sudo systemctl restart discord-clone${NC}"
echo ""

# Открытие портов в firewall
echo -e "${YELLOW}Открываем порты в firewall...${NC}"
sudo ufw allow ${APP_PORT}/tcp
sudo ufw allow ${STUN_PORT}/udp
echo -e "${GREEN}✅ Порты ${APP_PORT}/tcp и ${STUN_PORT}/udp открыты${NC}"
echo ""

echo -e "${GREEN}🎉 Установка завершена! Откройте в браузере: http://${SERVER_IP}:${APP_PORT}${NC}"
