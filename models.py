from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from datetime import datetime


db = SQLAlchemy()

# Определяем вспомогательные таблицы ДО определения классов
user_friends = db.Table('user_friends',
    db.Column('user_id', db.Integer, db.ForeignKey('user.id'), primary_key=True),
    db.Column('friend_id', db.Integer, db.ForeignKey('user.id'), primary_key=True)
)


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    is_online = db.Column(db.Boolean, default=False)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Отношения дружбы
    friends = db.relationship(
        'User',
        secondary='user_friends',
        primaryjoin='User.id == user_friends.c.user_id',
        secondaryjoin='User.id == user_friends.c.friend_id',
        backref=db.backref('friend_of', lazy='dynamic'),
        lazy='dynamic'
    )
    
    # Отправленные заявки в друзья
    sent_requests = db.relationship(
        'FriendRequest',
        foreign_keys='FriendRequest.from_user_id',
        backref='from_user',
        lazy='dynamic'
    )
    
    # Полученные заявки в друзья
    received_requests = db.relationship(
        'FriendRequest',
        foreign_keys='FriendRequest.to_user_id',
        backref='to_user',
        lazy='dynamic'
    )
    
    # Сообщения
    sent_messages = db.relationship(
        'Message',
        foreign_keys='Message.sender_id',
        backref='sender',
        lazy='dynamic'
    )
    
    received_messages = db.relationship(
        'Message',
        foreign_keys='Message.receiver_id',
        backref='receiver',
        lazy='dynamic'
    )
    
    # Звонки как инициатор
    calls_made = db.relationship(
        'Call',
        foreign_keys='Call.caller_id',
        backref='caller',
        lazy='dynamic'
    )
    
    # Звонки как получатель
    calls_received = db.relationship(
        'Call',
        foreign_keys='Call.receiver_id',
        backref='receiver',
        lazy='dynamic'
    )


class FriendRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    from_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    to_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    __table_args__ = (db.UniqueConstraint('from_user_id', 'to_user_id', name='unique_request'),)


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    is_read = db.Column(db.Boolean, default=False)


# Новая модель для звонков
class Call(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    caller_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    call_type = db.Column(db.String(20), default='audio')  # audio, video
    status = db.Column(db.String(20), default='ringing')  # ringing, active, ended, rejected
    started_at = db.Column(db.DateTime)
    ended_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)