#!/bin/bash

# Discord Clone - Однострочный установщик для сервера
# Использование: curl -sSL https://your-server.com/install.sh | bash
# Или: wget -qO- https://your-server.com/install.sh | bash

set -e  # Остановка при ошибке

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║     Discord Clone - Автоматическая установка на сервер   ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Функция для запроса IP адреса
get_server_ip() {
    local ip
    local default_ip=$(curl -s ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || echo "0.0.0.0")
    
    echo -e "${YELLOW}Определение IP адреса сервера...${NC}"
    echo -e "${GREEN}Внешний IP сервера: ${default_ip}${NC}"
    echo ""
    echo -e "${YELLOW}Введите IP адрес для доступа к серверу (оставьте пустым для использования $default_ip):${NC}"
    read -p "IP адрес: " ip
    
    if [ -z "$ip" ]; then
        ip=$default_ip
    fi
    
    # Проверка формата IP
    if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        echo "$ip"
    else
        echo -e "${RED}Неверный формат IP адреса. Использую $default_ip${NC}"
        echo "$default_ip"
    fi
}

# Функция для запроса порта
get_port() {
    local port_name=$1
    local default_port=$2
    local port
    
    echo -e "${YELLOW}Введите порт для $port_name (оставьте пустым для $default_port):${NC}"
    read -p "Порт: " port
    
    if [ -z "$port" ]; then
        port=$default_port
    fi
    
    # Проверка порта
    if [[ $port =~ ^[0-9]+$ ]] && [ $port -ge 1024 ] && [ $port -le 65535 ]; then
        echo "$port"
    else
        echo -e "${RED}Неверный порт. Использую $default_port${NC}"
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

    # Перезагрузка systemd
    sudo systemctl daemon-reload
    
    # Включение автозапуска
    sudo systemctl enable ${service_name}.service
    
    echo -e "${GREEN}✅ Сервис создан и добавлен в автозагрузку${NC}"
    echo -e "${GREEN}   Имя сервиса: ${service_name}${NC}"
}

# Функция создания конфигурационного файла
create_config_file() {
    local server_ip=$1
    local app_port=$2
    local stun_port=$3
    
    cat > .discord_config << EOF
{
    "server_ip": "${server_ip}",
    "app_port": ${app_port},
    "stun_port": ${stun_port},
    "stun_host": "${server_ip}",
    "app_host": "${server_ip}"
}
EOF
    
    echo -e "${GREEN}✅ Конфигурация сохранена в .discord_config${NC}"
}

# Основной процесс установки
echo -e "${BLUE}[1/8] Обновление системы и установка зависимостей...${NC}"
sudo apt update
sudo apt install -y make build-essential libssl-dev zlib1g-dev libbz2-dev \
    libreadline-dev libsqlite3-dev wget curl llvm libncurses5-dev \
    libncursesw5-dev xz-utils tk-dev libffi-dev liblzma-dev git net-tools

echo -e "${BLUE}[2/8] Установка pyenv...${NC}"
if [ ! -d "$HOME/.pyenv" ]; then
    curl https://pyenv.run | bash
else
    echo -e "${GREEN}pyenv уже установлен${NC}"
fi

# Настройка pyenv в текущей сессии
export PATH="$HOME/.pyenv/bin:$PATH"
eval "$(pyenv init --path)"
eval "$(pyenv virtualenv-init -)"

# Добавление в .bashrc если еще нет
if ! grep -q "pyenv" ~/.bashrc; then
    echo 'export PATH="$HOME/.pyenv/bin:$PATH"' >> ~/.bashrc
    echo 'eval "$(pyenv init --path)"' >> ~/.bashrc
    echo 'eval "$(pyenv virtualenv-init -)"' >> ~/.bashrc
    echo -e "${GREEN}✅ pyenv добавлен в .bashrc${NC}"
fi

echo -e "${BLUE}[3/8] Установка Python 3.10.14...${NC}"
pyenv install -s 3.10.14
pyenv global 3.10.14

echo -e "${BLUE}[4/8] Клонирование репозитория...${NC}"
if [ ! -d "diskordik" ]; then
    git clone https://github.com/dm3tr-0/diskordik.git
fi
cd diskordik

echo -e "${BLUE}[5/8] Настройка виртуального окружения...${NC}"
if [ ! -d "venv" ]; then
    python -m venv venv
fi
source venv/bin/activate

echo -e "${BLUE}[6/8] Установка Python пакетов...${NC}"
pip install --upgrade pip
pip install -r requirements.txt

echo -e "${BLUE}[7/8] Настройка конфигурации...${NC}"
# Запрос параметров у пользователя
SERVER_IP=$(get_server_ip)
APP_PORT=$(get_port "веб-сервера" 5000)
STUN_PORT=$(get_port "STUN сервера" 3478)

create_config_file "$SERVER_IP" "$APP_PORT" "$STUN_PORT"

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
echo -e "   • ${GREEN}http://${SERVER_IP}:${APP_PORT}${NC} (чат работает)"
echo -e "   • ${GREEN}https://${SERVER_IP}:${APP_PORT}${NC} (если SSL сгенерирован)"
echo ""
echo -e "${BLUE}Управление сервисом:${NC}"
echo -e "   • Статус:   ${YELLOW}sudo systemctl status discord-clone${NC}"
echo -e "   • Запуск:   ${YELLOW}sudo systemctl start discord-clone${NC}"
echo -e "   • Останов:  ${YELLOW}sudo systemctl stop discord-clone${NC}"
echo -e "   • Логи:     ${YELLOW}sudo journalctl -u discord-clone -f${NC}"
echo -e "   • Перезапуск: ${YELLOW}sudo systemctl restart discord-clone${NC}"
echo ""
echo -e "${YELLOW}Не забудьте открыть порты в firewall:${NC}"
echo -e "   sudo ufw allow ${APP_PORT}/tcp"
echo -e "   sudo ufw allow ${STUN_PORT}/udp"
echo ""

# Опциональный запуск firewall настройки
read -p "Хотите автоматически открыть порты в UFW? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if command -v ufw &> /dev/null; then
        sudo ufw allow ${APP_PORT}/tcp
        sudo ufw allow ${STUN_PORT}/udp
        echo -e "${GREEN}✅ Порты открыты!${NC}"
    else
        echo -e "${YELLOW}⚠️ UFW не установлен. Пропускаем...${NC}"
    fi
fi
