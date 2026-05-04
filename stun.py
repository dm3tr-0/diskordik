import socket
import threading
import struct
import json
import os

CONFIG_FILE = '.discord_config'

def load_stun_config():
    """Загрузить конфигурацию STUN сервера"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                return config.get('stun_host', '0.0.0.0'), config.get('stun_port', 3478)
        except:
            pass
    return '0.0.0.0', 3478

class STUNServer:
    """
    Простой STUN сервер для WebRTC
    STUN Binding Request (RFC 5389)
    """
    
    STUN_MAGIC_COOKIE = 0x2112A442
    STUN_BINDING_REQUEST = 0x0001
    STUN_BINDING_RESPONSE = 0x0101
    STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
    STUN_ATTR_MAPPED_ADDRESS = 0x0001
    
    def __init__(self, host=None, port=None):
        # Загружаем конфигурацию если параметры не переданы
        if host is None or port is None:
            host, port = load_stun_config()
        
        self.host = host
        self.port = port
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.running = False
        
    def start(self):
        self.sock.bind((self.host, self.port))
        self.running = True
        print(f"🚀 STUN Server running on {self.host}:{self.port}")
        
        while self.running:
            try:
                data, addr = self.sock.recvfrom(2048)
                # Запускаем обработку в отдельном потоке
                threading.Thread(target=self.handle_request, args=(data, addr)).start()
            except Exception as e:
                if self.running:
                    print(f"STUN error: {e}")
    
    def handle_request(self, data, addr):
        """Обрабатывает STUN запрос"""
        if len(data) < 20:
            return
        
        # Парсим STUN заголовок
        msg_type = struct.unpack('>H', data[0:2])[0]
        
        # Проверяем что это Binding Request
        if msg_type == self.STUN_BINDING_REQUEST:
            self.send_binding_response(data, addr)
    
    def send_binding_response(self, request_data, addr):
        """Отправляет STUN Binding Response с IP адресом клиента"""
        # Копируем ID транзакции из запроса
        transaction_id = request_data[8:20]
        
        # Строим ответ
        # Заголовок: тип (2 байта), длина (2 байта), cookie (4 байта), ID (12 байт)
        header = struct.pack('>HH', self.STUN_BINDING_RESPONSE, 12)
        header += struct.pack('>I', self.STUN_MAGIC_COOKIE)
        header += transaction_id
        
        # Атрибут XOR-MAPPED-ADDRESS
        # Тип (2), длина (2), резерв (1), семейство (1), порт (2), адрес (4)
        ip, port = addr
        
        attr_type = self.STUN_ATTR_XOR_MAPPED_ADDRESS
        attr_len = 8
        reserved = 0
        family = 0x01  # IPv4
        
        # XOR преобразование для порта и IP (RFC 5389)
        xor_port = port ^ (self.STUN_MAGIC_COOKIE >> 16)
        
        attr = struct.pack('>HHBBH', attr_type, attr_len, reserved, family, xor_port)
        
        # XOR для IP
        ip_int = struct.unpack('!I', socket.inet_aton(ip))[0]
        xor_ip_int = ip_int ^ self.STUN_MAGIC_COOKIE
        attr += struct.pack('>I', xor_ip_int)
        
        # Обновляем длину в заголовке
        response = header + attr
        
        # Отправляем ответ
        self.sock.sendto(response, addr)
        print(f"📡 STUN response sent to {addr}")
    
    def stop(self):
        self.running = False
        self.sock.close()

if __name__ == '__main__':
    server = STUNServer()
    try:
        server.start()
    except KeyboardInterrupt:
        print("\n🛑 STUN Server stopped")
        server.stop()