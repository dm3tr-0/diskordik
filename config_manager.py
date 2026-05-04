import os
import json
import ipaddress
import sys

CONFIG_FILE = '.discord_config'

def get_local_ip():
    """Получить локальный IP адрес"""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return None

def validate_ip(ip):
    """Проверить корректность IP адреса"""
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False

def create_config():
    """Создать конфигурационный файл"""
    print("\n" + "=" * 60)
    print("📝 ПЕРВИЧНАЯ НАСТРОЙКА ПРИЛОЖЕНИЯ")
    print("=" * 60)
    
    local_ip = get_local_ip()
    
    print(f"\nВаш локальный IP: {local_ip if local_ip else 'не определен'}")
    print("Для работы WebRTC звонков через интернет нужен внешний IP адрес сервера")
    print("Если вы запускаете локально, используйте: 127.0.0.1 или ваш локальный IP")
    print("Если на сервере, укажите его внешний IP адрес\n")
    
    while True:
        server_ip = input(f"Введите IP адрес сервера [{local_ip if local_ip else '0.0.0.0'}]: ").strip()
        if not server_ip:
            server_ip = local_ip if local_ip else '0.0.0.0'
        
        if validate_ip(server_ip) or server_ip == '0.0.0.0':
            break
        print("❌ Неверный IP адрес! Попробуйте снова.")
    
    print("\nНастройка портов (можно оставить значения по умолчанию):")
    
    while True:
        try:
            app_port = input(f"Введите порт для веб-сервера [5000]: ").strip()
            if not app_port:
                app_port = 5000
            else:
                app_port = int(app_port)
            if 1024 <= app_port <= 65535 or app_port == 5000:
                break
            print("❌ Порт должен быть от 1024 до 65535")
        except ValueError:
            print("❌ Введите число!")
    
    while True:
        try:
            stun_port = input(f"Введите порт для STUN сервера [3478]: ").strip()
            if not stun_port:
                stun_port = 3478
            else:
                stun_port = int(stun_port)
            if 1024 <= stun_port <= 65535 or stun_port == 3478:
                break
            print("❌ Порт должен быть от 1024 до 65535")
        except ValueError:
            print("❌ Введите число!")
    
    config = {
        'server_ip': server_ip,
        'app_port': app_port,
        'stun_port': stun_port,
        'stun_host': server_ip,  
        'app_host': server_ip    
    }
    
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=4)
    
    print("\n" + "=" * 60)
    print("✅ Конфигурация сохранена в файл: .discord_config")
    print(f"   Сервер будет доступен по адресу: http://{server_ip}:{app_port}")
    print(f"   Для HTTPS: https://{server_ip}:{app_port}")
    print(f"   STUN сервер: stun:{server_ip}:{stun_port}")
    print("=" * 60 + "\n")
    
    return config

def load_config():
    """Загрузить конфигурацию из файла"""
    if not os.path.exists(CONFIG_FILE):
        return create_config()
    
    try:
        with open(CONFIG_FILE, 'r') as f:
            config = json.load(f)
        
        # Проверка обязательных полей
        required = ['server_ip', 'app_port', 'stun_port']
        if not all(k in config for k in required):
            print("⚠️ Конфигурационный файл поврежден. Создаем новый...")
            return create_config()
        
        return config
    except Exception as e:
        print(f"⚠️ Ошибка чтения конфигурации: {e}")
        print("Создаем новую конфигурацию...")
        return create_config()