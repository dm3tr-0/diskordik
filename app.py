import eventlet
eventlet.monkey_patch()

import os
import uuid as uuid_lib
import ipaddress
import ssl
from datetime import datetime, timedelta
from threading import Thread

from flask import Flask, render_template, request, redirect, url_for, jsonify, flash
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import inspect, text

from models import db, User, FriendRequest, Message, Call
from stun import STUNServer
from config_manager import load_config

# Загружаем конфигурацию
config = load_config()

app = Flask(__name__)
# Секретный ключ можно переопределить через окружение
app.config['SECRET_KEY'] = os.environ.get('DISCORDIK_SECRET_KEY', 'your-secret-key-change-this')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///discord.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# STUN-сервер для WebRTC
server = STUNServer(host=config.get('stun_host', '0.0.0.0'), port=config.get('stun_port', 3478))


# ----------------------------------------------------------------------------
# E2E + доставка сообщений: отслеживание онлайн-сессий и временный кэш доставки
# ----------------------------------------------------------------------------
# Сессии пользователя (online): user_id -> set(socket id)
ONLINE_USERS = {}
# Временный буфер сообщений для онлайн-получателей (не пишется в БД).
# uuid -> {id, content(шифртекст), iv, sender_id, sender_name, receiver_id, timestamp_str, timestamp_dt}
PENDING_BUFFER = {}


def is_user_online(user_id):
    sids = ONLINE_USERS.get(user_id)
    return bool(sids)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# ----------------------------------------------------------------------------
# Создание БД + лёгкая миграция недостающих колонок (public_key, uuid, iv)
# ----------------------------------------------------------------------------
def run_lightweight_migrations():
    """db.create_all() не добавляет колонки к существующим таблицам.
    Добавляем public_key/uuid/iv вручную, если их нет (старые БД)."""
    try:
        insp = inspect(db.engine)
        if 'user' in insp.get_table_names():
            cols = {c['name'] for c in insp.get_columns('user')}
            if 'public_key' not in cols:
                db.session.execute(text("ALTER TABLE user ADD COLUMN public_key TEXT"))
        if 'message' in insp.get_table_names():
            cols = {c['name'] for c in insp.get_columns('message')}
            if 'uuid' not in cols:
                db.session.execute(text("ALTER TABLE message ADD COLUMN uuid VARCHAR(36)"))
            if 'iv' not in cols:
                db.session.execute(text("ALTER TABLE message ADD COLUMN iv VARCHAR(64)"))
        db.session.commit()
    except Exception as e:
        print(f"⚠️ Migration warning: {e}")
        db.session.rollback()


with app.app_context():
    db.create_all()
    run_lightweight_migrations()


# Конфигурация в контексте шаблонов
@app.context_processor
def inject_config():
    return {
        'config': config,
        'stun_url': f"stun:{config['server_ip']}:{config['stun_port']}"
    }


# ----------------------------------------------------------------------------
# Маршруты
# ----------------------------------------------------------------------------
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        if not username or not password:
            flash('Пожалуйста, заполните все поля', 'error')
            return render_template('register.html')

        if len(username) < 3 or len(username) > 80:
            flash('Имя пользователя должно быть от 3 до 80 символов', 'error')
            return render_template('register.html')

        if len(password) < 6:
            flash('Пароль должен содержать минимум 6 символов', 'error')
            return render_template('register.html')

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

            next_page = request.args.get('next')
            if next_page:
                return redirect(next_page)
            return redirect(url_for('dashboard'))

        flash('Неверное имя пользователя или пароль', 'error')
        return render_template('login.html')

    return render_template('login.html')


@app.route('/logout')
@login_required
def logout():
    # Завершаем все активные звонки
    active_calls = Call.query.filter(
        ((Call.caller_id == current_user.id) | (Call.receiver_id == current_user.id)),
        Call.status.in_(['ringing', 'active'])
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
    """Возвращает ещё не доставленные сообщения (шифртекст) с собеседником.
    После доставки они удаляются, поэтому обычно список пуст — история живёт
    в кэше устройств."""
    messages = Message.query.filter(
        ((Message.sender_id == current_user.id) & (Message.receiver_id == user_id)) |
        ((Message.sender_id == user_id) & (Message.receiver_id == current_user.id))
    ).order_by(Message.timestamp.asc()).all()

    return jsonify({
        'messages': [{
            'id': m.uuid or str(m.id),
            'content': m.content,
            'iv': m.iv,
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
        # Превью последнего сообщения сервер отдать не может: после доставки
        # сообщения удаляются (E2E). Клиент берёт превью из локального кэша.
        friends_data.append({
            'id': friend.id,
            'username': friend.username,
            'is_online': friend.is_online,
            'has_key': bool(friend.public_key)
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
        return jsonify({'error': 'Заявка уже отправлена'}), 400

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
    # SPA-интерфейс уже отрисовывает чат на дашборде; редирект туда же.
    return redirect(url_for('dashboard'))


# ----------------------------------------------------------------------------
# E2E: ключи
# ----------------------------------------------------------------------------
@app.route('/api/keys/me', methods=['GET'])
@login_required
def get_my_key():
    return jsonify({'public_key': current_user.public_key})


@app.route('/api/keys/upload', methods=['POST'])
@login_required
def upload_key():
    data = request.get_json(silent=True) or {}
    public_key = data.get('public_key')
    if not public_key:
        return jsonify({'error': 'public_key required'}), 400
    current_user.public_key = public_key
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/keys/<int:user_id>', methods=['GET'])
@login_required
def get_user_key(user_id):
    user = User.query.get_or_404(user_id)
    return jsonify({'public_key': user.public_key})


# ----------------------------------------------------------------------------
# Socket.IO
# ----------------------------------------------------------------------------
def _message_payload(uuid, content, iv, sender_id, sender_name, receiver_id, timestamp_str):
    return {
        'id': uuid,
        'content': content,
        'iv': iv,
        'sender_id': sender_id,
        'sender_name': sender_name,
        'receiver_id': receiver_id,
        'timestamp': timestamp_str
    }


@socketio.on('connect')
def handle_connect():
    if not current_user.is_authenticated:
        return

    sid = request.sid
    join_room(f'user_{current_user.id}')
    ONLINE_USERS.setdefault(current_user.id, set()).add(sid)

    was_offline = not current_user.is_online
    current_user.is_online = True
    current_user.last_seen = datetime.utcnow()
    db.session.commit()

    if was_offline:
        emit('user_status', {'user_id': current_user.id, 'status': 'online'}, broadcast=True)

    # Доставка сообщений, накопленных пока получатель был офлайн (в БД).
    pending = Message.query.filter_by(receiver_id=current_user.id).order_by(Message.timestamp.asc()).all()
    if pending:
        payload = [_message_payload(
            m.uuid or str(m.id), m.content, m.iv,
            m.sender_id, m.sender.username, m.receiver_id,
            m.timestamp.strftime('%H:%M')
        ) for m in pending]
        emit('pending_messages', {'messages': payload}, room=f'user_{current_user.id}')


@socketio.on('disconnect')
def handle_disconnect():
    if not current_user.is_authenticated:
        return

    sid = request.sid
    sids = ONLINE_USERS.get(current_user.id)
    if sids:
        sids.discard(sid)
        if not sids:
            # Последняя сессия закрыта -> пользователь офлайн.
            # Сливаем недоставленный буфер в БД, чтобы сообщения не потерялись.
            to_flush = [(uid, m) for uid, m in list(PENDING_BUFFER.items())
                        if m.get('receiver_id') == current_user.id]
            for uid, m in to_flush:
                try:
                    msg = Message(
                        uuid=uid,
                        content=m['content'],
                        iv=m.get('iv'),
                        sender_id=m['sender_id'],
                        receiver_id=m['receiver_id'],
                        timestamp=m.get('timestamp_dt', datetime.utcnow())
                    )
                    db.session.add(msg)
                except Exception as e:
                    print(f"⚠️ Flush buffer to DB error: {e}")
                PENDING_BUFFER.pop(uid, None)
            try:
                db.session.commit()
            except Exception as e:
                print(f"⚠️ Flush commit error: {e}")
                db.session.rollback()

            del ONLINE_USERS[current_user.id]
            current_user.is_online = False
            db.session.commit()
            emit('user_status', {'user_id': current_user.id, 'status': 'offline'}, broadcast=True)


@socketio.on('send_message')
def handle_send_message(data):
    """E2E: клиент присылает уже зашифрованное сообщение (content=шифртекст, iv).
    Если получатель онлайн -> сообщение живёт только в PENDING_BUFFER и удаляется
    сразу после доставки. Если офлайн -> сохраняется в БД до доставки."""
    receiver_id = data['receiver_id']
    ciphertext = data['content']        # base64 шифртекст
    iv = data.get('iv')                  # base64 nonce
    sender_id = current_user.id
    sender_name = current_user.username
    msg_uuid = str(uuid_lib.uuid4())
    now = datetime.utcnow()
    ts_str = now.strftime('%H:%M')

    message_data = _message_payload(msg_uuid, ciphertext, iv, sender_id, sender_name, receiver_id, ts_str)

    if is_user_online(receiver_id):
        # Получатель онлайн: только в памяти, в БД НЕ пишем.
        PENDING_BUFFER[msg_uuid] = {
            'content': ciphertext,
            'iv': iv,
            'sender_id': sender_id,
            'sender_name': sender_name,
            'receiver_id': receiver_id,
            'timestamp_str': ts_str,
            'timestamp_dt': now,
        }
        # Эхо отправителю + доставка получателю.
        emit('new_message', message_data, room=f'user_{sender_id}')
        emit('new_message', message_data, room=f'user_{receiver_id}')
    else:
        # Получатель офлайн: сохраняем в БД до момента доставки.
        message = Message(
            uuid=msg_uuid,
            content=ciphertext,
            iv=iv,
            sender_id=sender_id,
            receiver_id=receiver_id,
            timestamp=now
        )
        db.session.add(message)
        db.session.commit()
        # Эхо отправителю (получатель заберёт при подключении).
        emit('new_message', message_data, room=f'user_{sender_id}')


@socketio.on('message_received')
def handle_message_received(data):
    """Получатель подтвердил доставку -> удаляем сообщение с сервера."""
    msg_uuid = data.get('id')
    if not msg_uuid:
        return

    removed_from_buffer = PENDING_BUFFER.pop(msg_uuid, None)

    if removed_from_buffer is None:
        msg = Message.query.filter_by(uuid=msg_uuid).first()
        if msg:
            try:
                db.session.delete(msg)
                db.session.commit()
            except Exception as e:
                print(f"⚠️ Delete delivered message error: {e}")
                db.session.rollback()

    # Уведомляем отправителя о доставке (read receipt).
    if removed_from_buffer:
        sender_id = removed_from_buffer.get('sender_id')
    else:
        sender_id = data.get('sender_id')
    if sender_id:
        emit('message_delivered', {'id': msg_uuid}, room=f'user_{sender_id}')


@socketio.on('typing')
def handle_typing(data):
    receiver_id = data['receiver_id']
    is_typing = data['is_typing']

    emit('user_typing', {
        'user_id': current_user.id,
        'username': current_user.username,
        'is_typing': is_typing
    }, room=f'user_{receiver_id}')


# ----------------------------------------------------------------------------
# WebRTC сигналинг (аудио + демонстрация экрана)
# ----------------------------------------------------------------------------
@socketio.on('call_user')
def handle_call_user(data):
    receiver_id = data['receiver_id']
    call_type = 'audio'

    call = Call(
        caller_id=current_user.id,
        receiver_id=receiver_id,
        call_type=call_type,
        status='ringing'
    )
    db.session.add(call)
    db.session.commit()

    join_room(f'call_{call.id}')

    emit('incoming_call', {
        'call_id': call.id,
        'caller_id': current_user.id,
        'caller_name': current_user.username,
        'call_type': call_type
    }, room=f'user_{receiver_id}')

    emit('call_initialized', {
        'call_id': call.id,
        'call_type': call_type
    }, room=f'user_{current_user.id}')


@socketio.on('accept_call')
def handle_accept_call(data):
    call_id = data['call_id']
    call = db.session.get(Call, call_id)

    if call and call.receiver_id == current_user.id and call.status == 'ringing':
        call.status = 'active'
        call.started_at = datetime.utcnow()
        db.session.commit()

        join_room(f'call_{call.id}')

        emit('call_accepted', {
            'call_id': call_id,
            'receiver_id': current_user.id,
            'receiver_name': current_user.username
        }, room=f'user_{call.caller_id}')

        emit('call_connected', {
            'call_id': call_id
        }, room=f'call_{call.id}')


@socketio.on('reject_call')
def handle_reject_call(data):
    call_id = data['call_id']
    call = db.session.get(Call, call_id)

    if call and call.receiver_id == current_user.id and call.status == 'ringing':
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

        emit('call_ended', {
            'call_id': call_id
        }, room=f'call_{call.id}')

        leave_room(f'call_{call.id}')


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


@socketio.on('screen_share_started')
def handle_screen_share_started(data):
    call_id = data['call_id']
    sender_id = data['sender_id']
    sender_name = data['sender_name']

    call = db.session.get(Call, call_id)
    if call:
        receiver_id = call.receiver_id if call.caller_id == sender_id else call.caller_id
        emit('screen_share_started', {
            'call_id': call_id,
            'sender_id': sender_id,
            'sender_name': sender_name
        }, room=f'user_{receiver_id}')


@socketio.on('screen_share_stopped')
def handle_screen_share_stopped(data):
    call_id = data['call_id']
    sender_id = data['sender_id']

    call = db.session.get(Call, call_id)
    if call:
        receiver_id = call.receiver_id if call.caller_id == sender_id else call.caller_id
        emit('screen_share_stopped', {
            'call_id': call_id,
            'sender_id': sender_id
        }, room=f'user_{receiver_id}')


# ----------------------------------------------------------------------------
# SSL / запуск
# ----------------------------------------------------------------------------
def generate_self_signed_certificate():
    """Самоподписанный SSL сертификат для HTTPS (WebRTC требует безопасный контекст)."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    cert_file = 'cert.pem'
    key_file = 'key.pem'

    if os.path.exists(cert_file) and os.path.exists(key_file):
        return cert_file, key_file

    print("🔐 Generating SSL certificate...")

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "RU"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "Moscow"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Moscow"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Diskordik"),
        x509.NameAttribute(NameOID.COMMON_NAME, config['server_ip']),
    ])

    san_values = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address(config['server_ip'])),
    ]

    try:
        import socket
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        if local_ip and local_ip not in ["127.0.0.1", config['server_ip']]:
            san_values.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
    except Exception:
        pass

    san = x509.SubjectAlternativeName(san_values)

    cert = (x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow())
        .not_valid_after(datetime.utcnow() + timedelta(days=365))
        .add_extension(san, critical=False)
        .sign(private_key, hashes.SHA256()))

    with open(key_file, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))

    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print("✅ SSL certificate generated successfully!")
    return cert_file, key_file


def start_stun_server():
    """Запуск STUN-сервера (ошибки бинда не роняют приложение)."""
    try:
        server.start()
    except Exception as e:
        print(f"⚠️ STUN server не запущен: {e}")


def main():
    Thread(target=start_stun_server, daemon=True).start()

    force_http = os.environ.get('DISCORDIK_NO_HTTPS', '0') == '1'

    print("\n" + "=" * 60)
    print("Diskordik запущен!")
    print("=" * 60)
    print(f"\nКонфигурация:")
    print(f"   • IP адрес сервера: {config['server_ip']}")
    print(f"   • Хост приложения: {config.get('app_host', '0.0.0.0')}")
    print(f"   • Порт приложения: {config['app_port']}")
    print(f"   • STUN порт: {config['stun_port']}")
    print(f"   • E2E: включено (ключи на клиентах)")
    print("\nДоступные адреса:")
    print(f"   • http://{config['server_ip']}:{config['app_port']}")
    if not force_http:
        print(f"   • https://{config['server_ip']}:{config['app_port']} (звонки WebRTC)")
    print("=" * 60 + "\n")

    if force_http:
        print("🔓 Запуск в HTTP режиме (DISCORDIK_NO_HTTPS=1)...")
        socketio.run(app, host=config.get('app_host', '0.0.0.0'), port=config['app_port'], debug=False, allow_unsafe_werkzeug=True)
    elif os.path.exists('cert.pem') and os.path.exists('key.pem'):
        print("🔒 Запуск в HTTPS режиме...")
        try:
            socketio.run(
                app,
                host=config.get('app_host', '0.0.0.0'),
                port=config['app_port'],
                debug=False,
                keyfile='key.pem',
                certfile='cert.pem',
                allow_unsafe_werkzeug=True
            )
        except TypeError:
            print("⚠️ HTTPS не удалось. Запуск в HTTP режиме...")
            socketio.run(app, host=config.get('app_host', '0.0.0.0'), port=config['app_port'], debug=False, allow_unsafe_werkzeug=True)
    else:
        print("⚠️ SSL сертификаты не найдены. Запуск в HTTP режиме...")
        socketio.run(app, host=config.get('app_host', '0.0.0.0'), port=config['app_port'], debug=False, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
