// Глобальные переменные для WebRTC
let globalPeerConnection = null;
let globalCurrentCallId = null;
let globalCurrentCallType = null;
let globalLocalStream = null;
let isMuted = false;
let isSpeakerOff = false;
let isCallActive = false; // Добавляем флаг активного звонка
let hasAcceptedCall = false; // Флаг, принят ли звонок

// STUN/TURN серверы - используем конфигурацию из HTML
let configuration = {
    iceServers: [
        { urls: window.STUN_URL || 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
    // Загружаем STUN конфигурацию
    if (window.STUN_URL) {
        configuration.iceServers = [{ urls: window.STUN_URL }];
    }
    
    // Ждем инициализации socket
    const checkSocket = setInterval(() => {
        if (socket) {
            clearInterval(checkSocket);
            setupCallSocketListeners();
            setupCallWidgetControls();
        }
    }, 100);
});

function setupCallSocketListeners() {
    if (!socket) return;
    
    socket.on('incoming_call', (data) => {
        console.log('Входящий звонок:', data);
        // Не показываем модальное окно если звонок уже активен
        if (!isCallActive) {
            showGlobalCallModal(data);
        }
    });

    socket.on('call_initialized', (data) => {
        console.log('Звонок инициализирован:', data);
        if (!globalCurrentCallId) {
            globalCurrentCallId = data.call_id;
            isCallActive = true;
            hasAcceptedCall = false;
            
            // Ждем принятия звонка перед созданием offer
            showGlobalCallWidget('outgoing');
            updateCallWidgetStatus('Ожидание ответа...');
        }
    });

    socket.on('call_accepted', (data) => {
        console.log('Звонок принят:', data);
        if (data.call_id === globalCurrentCallId && !hasAcceptedCall) {
            hasAcceptedCall = true;
            updateCallWidgetStatus('Соединение...');
            // Создаем offer только после принятия звонка
            createAndSendOffer();
        }
    });

    socket.on('call_rejected', (data) => {
        console.log('Звонок отклонен:', data);
        if (data.call_id === globalCurrentCallId) {
            updateCallWidgetStatus('Звонок отклонен');
            showNotification('Звонок отклонен', 'Пользователь отклонил вызов');
            setTimeout(() => endGlobalCall(), 2000);
        }
    });

    socket.on('call_ended', (data) => {
        console.log('Звонок завершен:', data);
        if (data.call_id === globalCurrentCallId) {
            updateCallWidgetStatus('Звонок завершен');
            if (hasAcceptedCall) {
                showNotification('Звонок завершен', 'Собеседник завершил разговор');
            }
            setTimeout(() => endGlobalCall(), 1000);
        }
    });

    // WebRTC сигналинг
    socket.on('webrtc_offer', async (data) => {
        console.log('Получен offer:', data);
        if (data.call_id === globalCurrentCallId && hasAcceptedCall) {
            await handleRemoteOffer(data);
        }
    });

    socket.on('webrtc_answer', async (data) => {
        console.log('Получен answer:', data);
        if (data.call_id === globalCurrentCallId && globalPeerConnection && hasAcceptedCall) {
            await globalPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    });

    socket.on('webrtc_ice_candidate', async (data) => {
        if (data.call_id === globalCurrentCallId && globalPeerConnection && data.candidate && hasAcceptedCall) {
            try {
                await globalPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
                console.error('Ошибка добавления ICE кандидата:', e);
            }
        }
    });
}

function setupCallWidgetControls() {
    const muteBtn = document.getElementById('muteBtn');
    const speakerBtn = document.getElementById('speakerBtn');
    const endCallBtn = document.getElementById('endCallBtn');

    if (muteBtn) {
        muteBtn.addEventListener('click', toggleMute);
    }
    if (speakerBtn) {
        speakerBtn.addEventListener('click', toggleSpeaker);
    }
    if (endCallBtn) {
        endCallBtn.addEventListener('click', endGlobalCall);
    }
}

function showGlobalCallModal(data) {
    if (isCallActive) return;
    
    globalCurrentCallId = data.call_id;
    globalCurrentCallType = data.call_type;
    isCallActive = true;
    hasAcceptedCall = false;

    const modalCallerName = document.getElementById('modalCallerName');
    const modalCallStatus = document.getElementById('modalCallStatus');
    const modalCallAvatar = document.getElementById('modalCallerAvatar');
    
    if (modalCallerName) modalCallerName.textContent = `${data.caller_name}`;
    if (modalCallStatus) modalCallStatus.textContent = 'Входящий звонок...';
    if (modalCallAvatar) modalCallAvatar.innerHTML = data.call_type === 'video' ? '📹' : '🎤';
    
    const modalCallButtons = document.getElementById('modalCallButtons');
    if (modalCallButtons) {
        modalCallButtons.innerHTML = `
            <button class="modal-accept-btn" onclick="acceptCallFromModal()">📞 Принять</button>
            <button class="modal-reject-btn" onclick="rejectCallFromModal()">❌ Отклонить</button>
        `;
    }

    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'flex';
    
    // Показываем модальное окно, но НЕ запрашиваем медиа сразу
    // Медиа запросим только после принятия звонка
}

function acceptCallFromModal() {
    // Запрашиваем доступ к медиа только после принятия звонка
    const constraints = globalCurrentCallType === 'video'
        ? { audio: true, video: true }
        : { audio: true, video: false };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            console.log('Локальный поток готов');
            
            if (globalCurrentCallType === 'video') {
                const modalLocalVideo = document.getElementById('modalLocalVideo');
                const modalVideoContainer = document.getElementById('modalVideoContainer');
                const modalCallAvatarElem = document.getElementById('modalCallerAvatar');
                
                if (modalLocalVideo) modalLocalVideo.srcObject = stream;
                if (modalVideoContainer) modalVideoContainer.style.display = 'flex';
                if (modalCallAvatarElem) modalCallAvatarElem.style.display = 'none';
            }
            
            // Создаем peer connection
            if (!globalPeerConnection) {
                createGlobalPeerConnection();
            }
            
            // Добавляем треки
            if (globalPeerConnection && globalPeerConnection.getSenders().length === 0) {
                globalLocalStream.getTracks().forEach(track => {
                    globalPeerConnection.addTrack(track, globalLocalStream);
                });
            }
            
            // Отправляем сигнал accept_call
            if (socket) {
                hasAcceptedCall = true;
                socket.emit('accept_call', { call_id: globalCurrentCallId });
            }
            
            // Скрываем модальное окно и показываем виджет
            const globalCallModal = document.getElementById('globalCallModal');
            if (globalCallModal) globalCallModal.style.display = 'none';
            showGlobalCallWidget('active');
            updateCallWidgetStatus('Соединение...');
        })
        .catch(err => {
            console.error('Ошибка доступа к устройствам:', err);
            alert('Не удалось получить доступ к камере/микрофону. Пожалуйста, проверьте разрешения.');
            rejectCallFromModal();
        });
}

function rejectCallFromModal() {
    if (socket) {
        socket.emit('reject_call', { call_id: globalCurrentCallId });
    }
    closeGlobalCallModal();
    endGlobalCall();
}

function closeGlobalCallModal() {
    const globalCallModal = document.getElementById('globalCallModal');
    const modalVideoContainer = document.getElementById('modalVideoContainer');
    const modalCallAvatar = document.getElementById('modalCallerAvatar');
    const modalLocalVideo = document.getElementById('modalLocalVideo');
    
    if (globalCallModal) globalCallModal.style.display = 'none';
    if (modalVideoContainer) modalVideoContainer.style.display = 'none';
    if (modalCallAvatar) modalCallAvatar.style.display = 'flex';
    if (modalLocalVideo) modalLocalVideo.srcObject = null;
}

function showGlobalCallWidget(type) {
    const widget = document.getElementById('globalCallWidget');
    if (widget) {
        widget.style.display = 'flex';
        
        if (type === 'outgoing') {
            updateCallWidgetStatus('Вызываю...');
        } else if (type === 'active') {
            updateCallWidgetStatus('Соединение...');
        }
    }
}

function updateCallWidgetStatus(status) {
    const callWidgetStatus = document.getElementById('callWidgetStatus');
    if (callWidgetStatus) callWidgetStatus.textContent = status;
}

function startCall(type) {
    if (!currentChatId) {
        alert('Сначала выберите друга для звонка');
        return;
    }
    
    if (!socket) {
        alert('Нет соединения с сервером');
        return;
    }
    
    if (isCallActive) {
        alert('Уже есть активный звонок');
        return;
    }
    
    globalCurrentCallType = type;
    
    // Сначала запрашиваем медиа
    const constraints = type === 'video' 
        ? { audio: true, video: true }
        : { audio: true, video: false };
    
    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            isCallActive = true;
            hasAcceptedCall = false;
            
            // Создаем peer connection НЕ добавляя треки сразу
            createGlobalPeerConnection();
            
            // Отправляем запрос на звонок
            socket.emit('call_user', {
                receiver_id: currentChatId,
                call_type: type
            });

            showGlobalCallWidget('outgoing');
            updateCallWidgetStatus('Ожидание ответа...');
        })
        .catch(err => {
            console.error('Ошибка доступа к устройствам:', err);
            alert('Не удалось получить доступ к камере/микрофону. Пожалуйста, проверьте разрешения.');
            endGlobalCall();
        });
}

function createGlobalPeerConnection() {
    globalPeerConnection = new RTCPeerConnection(configuration);
    
    globalPeerConnection.onicecandidate = (event) => {
        if (event.candidate && socket && globalCurrentCallId && hasAcceptedCall) {
            socket.emit('webrtc_ice_candidate', {
                target_user_id: currentChatId,
                candidate: event.candidate,
                call_id: globalCurrentCallId
            });
        }
    };

    globalPeerConnection.ontrack = (event) => {
        console.log('Получен удаленный трек:', event.track.kind);
        if (event.track.kind === 'audio') {
            setupRemoteAudio(event.streams[0]);
        } else if (event.track.kind === 'video') {
            setupRemoteVideo(event.streams[0]);
        }
    };

    globalPeerConnection.onconnectionstatechange = () => {
        console.log('Состояние соединения:', globalPeerConnection.connectionState);
        switch(globalPeerConnection.connectionState) {
            case 'connected':
                updateCallWidgetStatus('Разговор');
                break;
            case 'disconnected':
                updateCallWidgetStatus('Соединение прервано');
                setTimeout(() => endGlobalCall(), 2000);
                break;
            case 'failed':
                updateCallWidgetStatus('Ошибка соединения');
                setTimeout(() => endGlobalCall(), 2000);
                break;
        }
    };
}

function setupRemoteAudio(stream) {
    let audioElement = document.getElementById('globalRemoteAudio');
    if (!audioElement) {
        audioElement = document.createElement('audio');
        audioElement.id = 'globalRemoteAudio';
        audioElement.autoplay = true;
        document.body.appendChild(audioElement);
    }
    audioElement.srcObject = stream;
}

function setupRemoteVideo(stream) {
    let videoElement = document.getElementById('globalRemoteVideo');
    if (!videoElement) {
        videoElement = document.createElement('video');
        videoElement.id = 'globalRemoteVideo';
        videoElement.autoplay = true;
        videoElement.playsinline = true;
        videoElement.className = 'remote-video-pip';
        document.body.appendChild(videoElement);
    }
    videoElement.srcObject = stream;
}

async function createAndSendOffer() {
    if (!globalPeerConnection) {
        createGlobalPeerConnection();
    }
    
    // Добавляем треки только сейчас, когда звонок принят
    if (globalLocalStream && globalPeerConnection.getSenders().length === 0) {
        globalLocalStream.getTracks().forEach(track => {
            globalPeerConnection.addTrack(track, globalLocalStream);
        });
    }

    try {
        const offer = await globalPeerConnection.createOffer();
        await globalPeerConnection.setLocalDescription(offer);
        
        if (socket && globalCurrentCallId && hasAcceptedCall) {
            socket.emit('webrtc_offer', {
                target_user_id: currentChatId,
                offer: offer,
                call_id: globalCurrentCallId
            });
        }
    } catch (err) {
        console.error('Ошибка создания offer:', err);
    }
}

async function handleRemoteOffer(data) {
    if (!globalPeerConnection) {
        createGlobalPeerConnection();
    }
    
    // Добавляем треки, если еще не добавлены
    if (globalLocalStream && globalPeerConnection.getSenders().length === 0) {
        globalLocalStream.getTracks().forEach(track => {
            globalPeerConnection.addTrack(track, globalLocalStream);
        });
    }

    try {
        await globalPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await globalPeerConnection.createAnswer();
        await globalPeerConnection.setLocalDescription(answer);
        
        if (socket && hasAcceptedCall) {
            socket.emit('webrtc_answer', {
                caller_id: data.caller_id,
                answer: answer,
                call_id: globalCurrentCallId
            });
        }
    } catch (err) {
        console.error('Ошибка обработки offer:', err);
    }
}

function toggleMute() {
    isMuted = !isMuted;
    if (globalLocalStream) {
        globalLocalStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    }
    const muteBtn = document.getElementById('muteBtn');
    if (muteBtn) muteBtn.textContent = isMuted ? '🔇' : '🎤';
}

function toggleSpeaker() {
    isSpeakerOff = !isSpeakerOff;
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) {
        audioElement.muted = isSpeakerOff;
    }
    const speakerBtn = document.getElementById('speakerBtn');
    if (speakerBtn) speakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
}

function endGlobalCall() {
    // Отправляем сигнал о завершении звонка
    if (socket && globalCurrentCallId && isCallActive) {
        socket.emit('end_call', { call_id: globalCurrentCallId });
    }
    
    if (globalPeerConnection) {
        globalPeerConnection.close();
        globalPeerConnection = null;
    }
    
    // Останавливаем локальные треки
    if (globalLocalStream) {
        globalLocalStream.getTracks().forEach(track => {
            track.stop();
        });
        globalLocalStream = null;
    }
    
    // Скрываем виджет и модальное окно
    const globalCallWidget = document.getElementById('globalCallWidget');
    if (globalCallWidget) globalCallWidget.style.display = 'none';
    
    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'none';
    
    // Очищаем аудио/видео элементы
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) {
        if (audioElement.srcObject) {
            audioElement.srcObject.getTracks().forEach(track => track.stop());
        }
        audioElement.remove();
    }
    
    const videoElement = document.getElementById('globalRemoteVideo');
    if (videoElement) {
        if (videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(track => track.stop());
        }
        videoElement.remove();
    }
    
    // Сбрасываем переменные
    globalCurrentCallId = null;
    globalCurrentCallType = null;
    isCallActive = false;
    hasAcceptedCall = false;
    isMuted = false;
    isSpeakerOff = false;
}

function stopLocalStream() {
    if (globalLocalStream) {
        globalLocalStream.getTracks().forEach(track => track.stop());
        globalLocalStream = null;
    }
}

function showNotification(title, message) {
    // Визуальное уведомление
    const notification = document.createElement('div');
    notification.className = 'toast-notification-modern';
    notification.innerHTML = `
        <div class="toast-icon">📞</div>
        <div class="toast-content">
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}