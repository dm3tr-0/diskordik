import ssl

from flask import Flask, render_template, request, redirect, url_for, jsonify, flash
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash

from datetime import datetime, timedelta
import os
import ipaddress
from threading import Thread

from models import db, User, FriendRequest, Message, Call
from stun import STUNServer


app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-change-this'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///discord.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

server = STUNServer(host='0.0.0.0', port=3478)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# Создание базы данных
with app.app_context():
    db.create_all()


# Маршруты
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    # Проверяем, авторизован ли уже пользователь
    if current_user.is_authenticated:
        # Если пользователь уже авторизован, перенаправляем на дашборд
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        # Проверка на пустые поля
        if not username or not password:
            flash('Пожалуйста, заполните все поля', 'error')
            return render_template('register.html')

        # Проверка длины имени пользователя
        if len(username) < 3 or len(username) > 80:
            flash('Имя пользователя должно быть от 3 до 80 символов', 'error')
            return render_template('register.html')

        # Проверка длины пароля
        if len(password) < 6:
            flash('Пароль должен содержать минимум 6 символов', 'error')
            return render_template('register.html')

        # Проверка на существующего пользователя
        if User.query.filter_by(username=username).first():
            flash('Пользователь с таким именем уже существует', 'error')
            return render_template('register.html')

        user = User(
            username=username,
            password_hash=generate_password_hash(password)
        )
        db.session.add(user)
        db.session.commit()

        login_user(user)
        user.is_online = True
        user.last_seen = datetime.utcnow()
        db.session.commit()

        flash('Регистрация прошла успешно! Добро пожаловать!', 'success')
        return redirect(url_for('dashboard'))

    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password_hash, password):
            login_user(user)
            user.is_online = True
            user.last_seen = datetime.utcnow()
            db.session.commit()

            # Получаем следующий URL или перенаправляем на дашборд
            next_page = request.args.get('next')
            if next_page:
                return redirect(next_page)
            return redirect(url_for('dashboard'))

        # Добавляем сообщение об ошибке
        flash('Неверное имя пользователя или пароль', 'error')
        return render_template('login.html')

    return render_template('login.html')


@app.route('/logout')
@login_required
def logout():
    active_calls = Call.query.filter(
        ((Call.caller_id == current_user.id) | (Call.receiver_id == current_user.id)),
        Call.status == 'active'
    ).all()
    
    for call in active_calls:
        call.status = 'ended'
        call.ended_at = datetime.utcnow()
        socketio.emit('call_ended', {'call_id': call.id}, room=f'call_{call.id}')
    
    db.session.commit()
    
    current_user.is_online = False
    db.session.commit()
    logout_user()
    return redirect(url_for('login'))


@app.route('/dashboard')
@login_required
def dashboard():
    friends = current_user.friends.all()
    
    friend_requests = FriendRequest.query.filter_by(
        to_user_id=current_user.id, 
        status='pending'
    ).all()
    
    recent_chats = []
    for friend in friends:
        last_message = Message.query.filter(
            ((Message.sender_id == current_user.id) & (Message.receiver_id == friend.id)) |
            ((Message.sender_id == friend.id) & (Message.receiver_id == current_user.id))
        ).order_by(Message.timestamp.desc()).first()
        
        recent_chats.append({
            'friend': friend,
            'last_message': last_message
        })
    
    return render_template('index.html', 
                         friends=friends, 
                         friend_requests=friend_requests,
                         recent_chats=recent_chats)


@app.route('/get_messages/<int:user_id>')
@login_required
def get_messages(user_id):
    messages = Message.query.filter(
        ((Message.sender_id == current_user.id) & (Message.receiver_id == user_id)) |
        ((Message.sender_id == user_id) & (Message.receiver_id == current_user.id))
    ).order_by(Message.timestamp.asc()).all()
    
    return jsonify({
        'messages': [{
            'id': m.id,
            'content': m.content,
            'sender_id': m.sender_id,
            'sender_name': m.sender.username,
            'timestamp': m.timestamp.strftime('%H:%M'),
            'receiver_id': m.receiver_id
        } for m in messages]
    })


@app.route('/get_friends_list')
@login_required
def get_friends_list():
    friends = current_user.friends.all()
    friends_data = []
    
    for friend in friends:
        last_message = Message.query.filter(
            ((Message.sender_id == current_user.id) & (Message.receiver_id == friend.id)) |
            ((Message.sender_id == friend.id) & (Message.receiver_id == current_user.id))
        ).order_by(Message.timestamp.desc()).first()
        
        friends_data.append({
            'id': friend.id,
            'username': friend.username,
            'is_online': friend.is_online,
            'last_message': last_message.content[:30] + '...' if last_message and len(last_message.content) > 30 else (last_message.content if last_message else None)
        })
    
    return jsonify({'friends': friends_data})


@app.route('/get_friend_requests')
@login_required
def get_friend_requests():
    friend_requests = FriendRequest.query.filter_by(
        to_user_id=current_user.id, 
        status='pending'
    ).all()
    
    return jsonify({
        'requests': [{
            'id': r.id,
            'username': r.from_user.username
        } for r in friend_requests]
    })


@app.route('/search_users')
@login_required
def search_users():
    query = request.args.get('q', '')
    users = User.query.filter(
        User.username.contains(query),
        User.id != current_user.id
    ).limit(10).all()
    
    return jsonify([{'id': u.id, 'username': u.username} for u in users])


@app.route('/send_friend_request/<int:user_id>', methods=['POST'])
@login_required
def send_friend_request(user_id):
    existing = FriendRequest.query.filter_by(
        from_user_id=current_user.id,
        to_user_id=user_id,
        status='pending'
    ).first()
    
    if existing:
        return jsonify({'error': 'Request already sent'}), 400
    
    friend_request = FriendRequest(
        from_user_id=current_user.id,
        to_user_id=user_id
    )
    db.session.add(friend_request)
    db.session.commit()
    
    socketio.emit('friend_request_notification', {
        'from_user': current_user.username,
        'request_id': friend_request.id
    }, room=f'user_{user_id}')
    
    return jsonify({'success': True})


@app.route('/accept_friend_request/<int:request_id>', methods=['POST'])
@login_required
def accept_friend_request(request_id):
    friend_request = FriendRequest.query.get_or_404(request_id)
    
    if friend_request.to_user_id != current_user.id:
        return jsonify({'error': 'Unauthorized'}), 403
    
    friend_request.status = 'accepted'
    
    user = User.query.get(friend_request.from_user_id)
    current_user.friends.append(user)
    user.friends.append(current_user)
    
    db.session.commit()
    
    return jsonify({'success': True})


@app.route('/reject_friend_request/<int:request_id>', methods=['POST'])
@login_required
def reject_friend_request(request_id):
    friend_request = FriendRequest.query.get_or_404(request_id)
    
    if friend_request.to_user_id != current_user.id:
        return jsonify({'error': 'Unauthorized'}), 403
    
    friend_request.status = 'rejected'
    db.session.commit()
    
    return jsonify({'success': True})


@app.route('/chat/<int:user_id>')
@login_required
def chat(user_id):
    friend = User.query.get_or_404(user_id)
    
    if friend not in current_user.friends:
        return redirect(url_for('dashboard'))
    
    messages = Message.query.filter(
        ((Message.sender_id == current_user.id) & (Message.receiver_id == user_id)) |
        ((Message.sender_id == user_id) & (Message.receiver_id == current_user.id))
    ).order_by(Message.timestamp.asc()).all()
    
    return render_template('chat.html', friend=friend, messages=messages)


@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        join_room(f'user_{current_user.id}')
        current_user.is_online = True
        db.session.commit()
        emit('user_status', {'user_id': current_user.id, 'status': 'online'}, broadcast=True)


@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated:
        current_user.is_online = False
        db.session.commit()
        emit('user_status', {'user_id': current_user.id, 'status': 'offline'}, broadcast=True)


@socketio.on('send_message')
def handle_send_message(data):
    receiver_id = data['receiver_id']
    content = data['content']
    
    message = Message(
        content=content,
        sender_id=current_user.id,
        receiver_id=receiver_id
    )
    db.session.add(message)
    db.session.commit()
    
    message_data = {
        'id': message.id,
        'content': content,
        'sender_id': current_user.id,
        'sender_name': current_user.username,
        'timestamp': message.timestamp.strftime('%H:%M'),
        'receiver_id': receiver_id
    }
    
    emit('new_message', message_data, room=f'user_{current_user.id}')
    emit('new_message', message_data, room=f'user_{receiver_id}')


@socketio.on('typing')
def handle_typing(data):
    receiver_id = data['receiver_id']
    is_typing = data['is_typing']
    
    emit('user_typing', {
        'user_id': current_user.id,
        'username': current_user.username,
        'is_typing': is_typing
    }, room=f'user_{receiver_id}')


# WebRTC сигналинг
@socketio.on('call_user')
def handle_call_user(data):
    receiver_id = data['receiver_id']
    call_type = data.get('call_type', 'audio')
    
    # Создаем запись о звонке
    call = Call(
        caller_id=current_user.id,
        receiver_id=receiver_id,
        call_type=call_type,
        status='ringing'
    )
    db.session.add(call)
    db.session.commit()
    
    # Отправляем уведомление о звонке
    emit('incoming_call', {
        'call_id': call.id,
        'caller_id': current_user.id,
        'caller_name': current_user.username,
        'call_type': call_type
    }, room=f'user_{receiver_id}')
    
    # Отправляем call_id обратно инициатору
    emit('call_initialized', {'call_id': call.id}, room=f'user_{current_user.id}')


@socketio.on('accept_call')
def handle_accept_call(data):
    call_id = data['call_id']
    call = db.session.get(Call, call_id)
    
    if call and call.receiver_id == current_user.id:
        call.status = 'active'
        call.started_at = datetime.utcnow()
        db.session.commit()
        
        # Создаем комнату для звонка
        join_room(f'call_{call_id}')
        
        emit('call_accepted', {
            'call_id': call_id,
            'receiver_id': current_user.id,
            'receiver_name': current_user.username
        }, room=f'user_{call.caller_id}')
        
        emit('call_connected', {
            'call_id': call_id
        }, room=f'call_{call_id}')


@socketio.on('reject_call')
def handle_reject_call(data):
    call_id = data['call_id']
    call = db.session.get(Call, call_id)
    
    if call and call.receiver_id == current_user.id:
        call.status = 'rejected'
        call.ended_at = datetime.utcnow()
        db.session.commit()
        
        emit('call_rejected', {
            'call_id': call_id
        }, room=f'user_{call.caller_id}')


@socketio.on('end_call')
def handle_end_call(data):
    call_id = data['call_id']
    call = db.session.get(Call, call_id)
    
    if call and (call.caller_id == current_user.id or call.receiver_id == current_user.id):
        call.status = 'ended'
        call.ended_at = datetime.utcnow()
        db.session.commit()
        
        leave_room(f'call_{call_id}')
        
        emit('call_ended', {
            'call_id': call_id
        }, room=f'call_{call_id}')


# WebRTC ICE кандидаты и SDP
@socketio.on('webrtc_offer')
def handle_webrtc_offer(data):
    target_user = data['target_user_id']
    offer = data['offer']
    call_id = data['call_id']
    
    emit('webrtc_offer', {
        'offer': offer,
        'caller_id': current_user.id,
        'call_id': call_id
    }, room=f'user_{target_user}')


@socketio.on('webrtc_answer')
def handle_webrtc_answer(data):
    caller_id = data['caller_id']
    answer = data['answer']
    call_id = data['call_id']
    
    emit('webrtc_answer', {
        'answer': answer,
        'receiver_id': current_user.id,
        'call_id': call_id
    }, room=f'user_{caller_id}')


@socketio.on('webrtc_ice_candidate')
def handle_webrtc_ice_candidate(data):
    target_user = data['target_user_id']
    candidate = data['candidate']
    call_id = data['call_id']
    
    emit('webrtc_ice_candidate', {
        'candidate': candidate,
        'sender_id': current_user.id,
        'call_id': call_id
    }, room=f'user_{target_user}')


def generate_self_signed_certificate():
    """Генерирует самоподписанный SSL сертификат для HTTPS"""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    
    cert_file = 'cert.pem'
    key_file = 'key.pem'
    
    # Проверяем, существует ли сертификат
    if os.path.exists(cert_file) and os.path.exists(key_file):
        return cert_file, key_file
    
    print("🔐 Generating SSL certificate...")
    
    # Генерируем приватный ключ
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    
    # Создаем самоподписанный сертификат
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "RU"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "Moscow"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Moscow"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Discord Clone"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])
    
    # Получаем локальный IP
    san_values = [
        x509.DNSName("localhost"),
        x509.DNSName("*.localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    ]
    
    # Добавляем внешний IP если есть
    try:
        import socket
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        if local_ip and local_ip != "127.0.0.1":
            san_values.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
            print(f"   Adding IP: {local_ip}")
    except:
        pass
    
    san = x509.SubjectAlternativeName(san_values)
    
    # Создаем сертификат
    cert = (x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow())
        .not_valid_after(datetime.utcnow() + timedelta(days=365))
        .add_extension(san, critical=False)
        .sign(private_key, hashes.SHA256()))
    
    # Сохраняем ключ
    with open(key_file, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))
    
    # Сохраняем сертификат
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    
    print("✅ SSL certificate generated successfully!")
    return cert_file, key_file


def start_stun_server():
    """
    Запускает STUN-сервер
    """
    try:
        server.start()
    except KeyboardInterrupt:
        print("\n🛑 STUN Server stopped")
        server.stop()


def main():
    # Запуск STUN-сервера в отдельном потоке
    Thread(target=start_stun_server, daemon=True).start()

    # Подгрузка сертификатов
    generate_self_signed_certificate()

    print("\n" + "=" * 60)
    print("Discord Clone Запущен!")
    print("=" * 60)
    print("\nДоступные адреса:")
    print("   • http://localhost:5000     (чат работает, но ЗВОНКИ НЕ РАБОТАЮТ)")
    print("   • https://localhost:5000    (чат и звонки работают)")
    print("=" * 60 + "\n")

    if os.path.exists('cert.pem') and os.path.exists('key.pem'):
        print("Найдены SSL сертификаты! Запуск в HTTPS режиме...")

        try:
            socketio.run(
                app,
                host='0.0.0.0',
                port=5000,
                debug=True,
                keyfile='key.pem',
                certfile='cert.pem'
            )

        except TypeError:
            print(" Не удалось запустить HTTPS режим. Запуск в HTTP режиме...")
            socketio.run(app, host='0.0.0.0', port=5000, debug=True)
    else:
        print(" SSL сертификаты не найдены. Запуск в HTTP режиме...")
        socketio.run(app, host='0.0.0.0', port=5000, debug=True)


if __name__ == '__main__':
    main()