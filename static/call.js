// Глобальные переменные для WebRTC
let globalPeerConnection = null;
let globalCurrentCallId = null;
let globalCurrentCallType = null;
let globalLocalStream = null;
let isMuted = false;
let isSpeakerOff = false;
let isCallActive = false;
let hasAcceptedCall = false;
let isScreenSharing = false;
let screenShareStream = null;
let screenShareSender = null;
let isRemoteScreenSharing = false;
let screenShareManuallyClosed = false; // Флаг, что пользователь закрыл демонстрацию вручную

// Новые переменные для пинга и громкости
let pingInterval = null;
let currentPing = 0;
let remoteAudioGains = new Map();
let currentRemoteAudioElement = null;
let currentRemoteStream = null;

// Переменные для демонстрации экрана
let screenShareStreams = new Map();
let remoteScreenShareStream = null;
let screenShareMinimized = false;
let currentScreenShareSenderName = ''; // Имя того, кто демонстрирует

// STUN/TURN серверы
let configuration = {
    iceServers: [
        { urls: window.STUN_URL }
    ]
};

// Инициализация
document.addEventListener('DOMContentLoaded', function() {
    if (window.STUN_URL) {
        configuration.iceServers = [{ urls: window.STUN_URL }];
    }
    
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
            
            showGlobalCallWidget('outgoing');
            updateCallWidgetStatus('Ожидание ответа...');
        }
    });

    socket.on('call_accepted', (data) => {
        console.log('Звонок принят:', data);
        if (data.call_id === globalCurrentCallId && !hasAcceptedCall) {
            hasAcceptedCall = true;
            updateCallWidgetStatus('Соединение...');
            createAndSendOffer();
            startPingMeasurement();
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

    socket.on('screen_share_started', (data) => {
        console.log('Начата демонстрация экрана:', data);
        if (data.call_id === globalCurrentCallId && data.sender_id !== currentUserId) {
            isRemoteScreenSharing = true;
            currentScreenShareSenderName = data.sender_name;
            screenShareManuallyClosed = false; // Сбрасываем флаг при новой демонстрации
            showScreenShareInChat(data.sender_name);
            showNotification('Демонстрация экрана', `${data.sender_name} начал демонстрацию экрана`);
        }
    });

    socket.on('screen_share_stopped', (data) => {
        console.log('Демонстрация экрана остановлена:', data);
        if (data.call_id === globalCurrentCallId && data.sender_id !== currentUserId) {
            isRemoteScreenSharing = false;
            currentScreenShareSenderName = '';
            hideScreenShareInChat();
            showNotification('Демонстрация завершена', 'Пользователь остановил демонстрацию экрана');
        }
    });

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

    if (muteBtn) muteBtn.addEventListener('click', toggleMute);
    if (speakerBtn) speakerBtn.addEventListener('click', toggleSpeaker);
    if (endCallBtn) endCallBtn.addEventListener('click', endGlobalCall);
}

function showGlobalCallModal(data) {
    if (isCallActive) return;
    
    globalCurrentCallId = data.call_id;
    globalCurrentCallType = 'audio';
    isCallActive = true;
    hasAcceptedCall = false;

    const modalCallerName = document.getElementById('modalCallerName');
    const modalCallStatus = document.getElementById('modalCallStatus');
    const modalCallAvatar = document.getElementById('modalCallerAvatar');
    
    if (modalCallerName) modalCallerName.textContent = `${data.caller_name}`;
    if (modalCallStatus) modalCallStatus.textContent = 'Входящий звонок...';
    if (modalCallAvatar) modalCallAvatar.innerHTML = '🎤';
    
    const modalCallButtons = document.getElementById('modalCallButtons');
    if (modalCallButtons) {
        modalCallButtons.innerHTML = `
            <button class="modal-accept-btn" onclick="acceptCallFromModal()">📞 Принять</button>
            <button class="modal-reject-btn" onclick="rejectCallFromModal()">❌ Отклонить</button>
        `;
    }

    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'flex';
}

function acceptCallFromModal() {
    const constraints = { audio: true, video: false };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            console.log('Локальный поток готов');
            
            if (!globalPeerConnection) {
                createGlobalPeerConnection();
            }
            
            if (globalPeerConnection && globalPeerConnection.getSenders().length === 0) {
                globalLocalStream.getTracks().forEach(track => {
                    globalPeerConnection.addTrack(track, globalLocalStream);
                });
            }
            
            if (socket) {
                hasAcceptedCall = true;
                socket.emit('accept_call', { call_id: globalCurrentCallId });
            }
            
            const globalCallModal = document.getElementById('globalCallModal');
            if (globalCallModal) globalCallModal.style.display = 'none';
            showGlobalCallWidget('active');
            updateCallWidgetStatus('Соединение...');
        })
        .catch(err => {
            console.error('Ошибка доступа к микрофону:', err);
            alert('Не удалось получить доступ к микрофону. Пожалуйста, проверьте разрешения.');
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
    if (globalCallModal) globalCallModal.style.display = 'none';
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
    
    globalCurrentCallType = 'audio';
    
    window.currentCallPeerId = currentChatId;
    window.currentCallPeerUsername = currentChatUsername;
    
    const constraints = { audio: true, video: false };
    
    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            isCallActive = true;
            hasAcceptedCall = false;
            
            createGlobalPeerConnection();
            
            socket.emit('call_user', {
                receiver_id: currentChatId,
                call_type: 'audio'
            });

            showGlobalCallWidget('outgoing');
            updateCallWidgetStatus('Ожидание ответа...');
        })
        .catch(err => {
            console.error('Ошибка доступа к микрофону:', err);
            alert('Не удалось получить доступ к микрофону. Пожалуйста, проверьте разрешения.');
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
            if (event.streams[0]) {
                setupRemoteAudio(event.streams[0]);
            }
        } else if (event.track.kind === 'video') {
            console.log('Получен видеопоток демонстрации!');
            if (event.streams[0]) {
                remoteScreenShareStream = event.streams[0];
                // Если демонстрация активна и пользователь не закрыл её вручную
                if (isRemoteScreenSharing && !screenShareManuallyClosed) {
                    displayScreenShareVideo(event.streams[0]);
                } else if (isRemoteScreenSharing && screenShareManuallyClosed) {
                    // Показываем кнопку восстановления
                    showReconnectButton();
                }
            }
        }
    };

    globalPeerConnection.onconnectionstatechange = () => {
        console.log('Состояние соединения:', globalPeerConnection.connectionState);
        switch(globalPeerConnection.connectionState) {
            case 'connected':
                updateCallWidgetStatus('Разговор');
                startPingMeasurement();
                showDiscordCallPanel();
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
        audioElement.style.display = 'none';
        document.body.appendChild(audioElement);
    }
    audioElement.srcObject = stream;
    currentRemoteAudioElement = audioElement;
    currentRemoteStream = stream;
    
    if (window.currentCallPeerId && remoteAudioGains.has(window.currentCallPeerId)) {
        const gainValue = remoteAudioGains.get(window.currentCallPeerId);
        setRemoteVolume(gainValue);
    }
}

function showReconnectButton() {
    // Удаляем существующую кнопку если есть
    const existingBtn = document.getElementById('reconnectScreenShareBtn');
    if (existingBtn) existingBtn.remove();
    
    // Создаем кнопку восстановления в области сообщений
    const messagesWrapper = document.querySelector('.messages-wrapper');
    if (!messagesWrapper) return;
    
    const reconnectBtn = document.createElement('div');
    reconnectBtn.id = 'reconnectScreenShareBtn';
    reconnectBtn.className = 'reconnect-screen-share-btn';
    reconnectBtn.innerHTML = `
        <span>🖥️ ${escapeHtml(currentScreenShareSenderName)} демонстрирует экран</span>
        <button class="reconnect-action-btn">Смотреть демонстрацию</button>
    `;
    
    reconnectBtn.querySelector('.reconnect-action-btn').addEventListener('click', () => {
        // Убираем флаг ручного закрытия
        screenShareManuallyClosed = false;
        // Показываем демонстрацию
        showScreenShareInChat(currentScreenShareSenderName);
        if (remoteScreenShareStream) {
            displayScreenShareVideo(remoteScreenShareStream);
        }
        // Удаляем кнопку восстановления
        reconnectBtn.remove();
    });
    
    messagesWrapper.insertBefore(reconnectBtn, messagesWrapper.firstChild);
}

function showScreenShareInChat(senderName) {
    // Удаляем кнопку восстановления если есть
    const reconnectBtn = document.getElementById('reconnectScreenShareBtn');
    if (reconnectBtn) reconnectBtn.remove();
    
    // Проверяем, есть ли уже контейнер для демонстрации
    let screenContainer = document.getElementById('screenShareContainer');
    
    if (!screenContainer) {
        // Создаем контейнер в обертке сообщений
        const messagesWrapper = document.querySelector('.messages-wrapper');
        if (!messagesWrapper) return;
        
        screenContainer = document.createElement('div');
        screenContainer.id = 'screenShareContainer';
        screenContainer.className = 'screen-share-container-inline';
        screenContainer.innerHTML = `
            <div class="screen-share-header">
                <div class="screen-share-title">
                    <span>🖥️</span>
                    <span>${escapeHtml(senderName)} демонстрирует экран</span>
                </div>
                <div class="screen-share-controls-inline">
                    <button class="screen-share-minimize" id="screenShareMinimizeBtn" title="Свернуть">−</button>
                    <button class="screen-share-close" id="screenShareCloseBtn" title="Скрыть">✖</button>
                </div>
            </div>
            <div class="screen-share-video-wrapper">
                <video id="screenShareVideo" class="screen-share-video" autoplay playsinline></video>
                <div class="screen-share-volume-control">
                    <span>🔊</span>
                    <input type="range" id="screenShareVolumeSlider" class="volume-slider-small" min="0" max="200" value="100" step="1">
                    <span id="screenShareVolumeValue">100%</span>
                </div>
            </div>
        `;
        
        // Вставляем в начало обертки сообщений
        messagesWrapper.insertBefore(screenContainer, messagesWrapper.firstChild);
        
        // Добавляем обработчики
        const minimizeBtn = document.getElementById('screenShareMinimizeBtn');
        const closeBtn = document.getElementById('screenShareCloseBtn');
        const volumeSlider = document.getElementById('screenShareVolumeSlider');
        const volumeValue = document.getElementById('screenShareVolumeValue');
        
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => toggleScreenShareMinimize());
        }
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                // Устанавливаем флаг, что пользователь закрыл демонстрацию вручную
                screenShareManuallyClosed = true;
                // Скрываем контейнер
                if (screenContainer) screenContainer.remove();
                // Показываем кнопку восстановления
                if (isRemoteScreenSharing) {
                    showReconnectButton();
                }
            });
        }
        
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                const volume = parseInt(e.target.value);
                volumeValue.textContent = volume + '%';
                const video = document.getElementById('screenShareVideo');
                if (video) video.volume = volume / 100;
                localStorage.setItem('screenShareVolume', volume);
            });
            
            const savedVolume = localStorage.getItem('screenShareVolume');
            if (savedVolume) {
                volumeSlider.value = savedVolume;
                volumeValue.textContent = savedVolume + '%';
            }
        }
    }
    
    // Если уже есть поток, отображаем его
    if (remoteScreenShareStream) {
        displayScreenShareVideo(remoteScreenShareStream);
    }
    
    // Показываем контейнер
    screenContainer.style.display = 'block';
    screenContainer.classList.remove('minimized');
}

function displayScreenShareVideo(stream) {
    const video = document.getElementById('screenShareVideo');
    if (video) {
        video.srcObject = stream;
        video.style.display = 'block';
        
        // Убираем индикатор загрузки если есть
        const loadingIndicator = document.querySelector('.screen-share-loading');
        if (loadingIndicator) loadingIndicator.remove();
    }
}

function toggleScreenShareMinimize() {
    const container = document.getElementById('screenShareContainer');
    const minimizeBtn = document.getElementById('screenShareMinimizeBtn');
    
    if (container) {
        if (container.classList.contains('minimized')) {
            container.classList.remove('minimized');
            if (minimizeBtn) minimizeBtn.textContent = '−';
        } else {
            container.classList.add('minimized');
            if (minimizeBtn) minimizeBtn.textContent = '□';
        }
    }
}

function hideScreenShareInChat() {
    const container = document.getElementById('screenShareContainer');
    if (container) {
        // Останавливаем видео
        const video = document.getElementById('screenShareVideo');
        if (video && video.srcObject) {
            video.srcObject = null;
        }
        container.remove();
    }
    
    // Удаляем кнопку восстановления
    const reconnectBtn = document.getElementById('reconnectScreenShareBtn');
    if (reconnectBtn) reconnectBtn.remove();
}

async function createAndSendOffer() {
    if (!globalPeerConnection) {
        createGlobalPeerConnection();
    }
    
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
    
    const panelMuteBtn = document.getElementById('discordMuteBtn');
    if (panelMuteBtn) panelMuteBtn.textContent = isMuted ? '🔇' : '🎤';
}

function toggleSpeaker() {
    isSpeakerOff = !isSpeakerOff;
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) audioElement.muted = isSpeakerOff;
    const speakerBtn = document.getElementById('speakerBtn');
    if (speakerBtn) speakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
    
    const panelSpeakerBtn = document.getElementById('discordSpeakerBtn');
    if (panelSpeakerBtn) panelSpeakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
}

async function startScreenShare() {
    if (!globalPeerConnection || !isCallActive) {
        showNotification('Ошибка', 'Нет активного звонка');
        return;
    }
    
    if (isScreenSharing) {
        stopScreenShare();
        return;
    }
    
    try {
        console.log('Запрос демонстрации экрана...');
        
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always"
            },
            audio: true
        });
        
        console.log('Получен поток демонстрации');
        
        screenShareStream = stream;
        isScreenSharing = true;
        
        const videoTrack = screenShareStream.getVideoTracks()[0];
        
        if (videoTrack) {
            const senders = globalPeerConnection.getSenders();
            let videoSender = senders.find(s => s.track && s.track.kind === 'video');
            
            if (videoSender) {
                await videoSender.replaceTrack(videoTrack);
            } else {
                screenShareSender = globalPeerConnection.addTrack(videoTrack, screenShareStream);
            }
        }
        
        const audioTrack = screenShareStream.getAudioTracks()[0];
        if (audioTrack) {
            globalPeerConnection.addTrack(audioTrack, screenShareStream);
        }
        
        // Показываем индикатор своей демонстрации в чате
        showOwnScreenShareIndicator();
        
        if (socket && globalCurrentCallId) {
            socket.emit('screen_share_started', {
                call_id: globalCurrentCallId,
                sender_id: currentUserId,
                sender_name: window.currentUsername || 'Пользователь'
            });
        }
        
        updateScreenShareButton(true);
        
        videoTrack.onended = () => {
            stopScreenShare();
        };
        
        await renegotiateConnection();
        
        showNotification('Демонстрация экрана', 'Демонстрация начата');
        
    } catch (err) {
        console.error('Ошибка запуска демонстрации экрана:', err);
        if (err.name === 'NotAllowedError') {
            showNotification('Ошибка', 'Разрешение на демонстрацию экрана не получено');
        } else if (err.name === 'NotFoundError') {
            showNotification('Ошибка', 'Нет доступных источников для демонстрации');
        } else {
            showNotification('Ошибка', 'Не удалось начать демонстрацию экрана');
        }
    }
}

function showOwnScreenShareIndicator() {
    let indicator = document.getElementById('ownScreenShareIndicator');
    
    if (!indicator) {
        const messagesWrapper = document.querySelector('.messages-wrapper');
        if (!messagesWrapper) return;
        
        indicator = document.createElement('div');
        indicator.id = 'ownScreenShareIndicator';
        indicator.className = 'own-screen-share-indicator';
        indicator.innerHTML = `
            <div class="own-screen-share-content">
                <span>🖥️ Вы демонстрируете экран</span>
                <button class="stop-share-btn" id="stopOwnScreenShareBtn">Остановить</button>
            </div>
        `;
        
        messagesWrapper.insertBefore(indicator, messagesWrapper.firstChild);
        
        document.getElementById('stopOwnScreenShareBtn')?.addEventListener('click', () => {
            stopScreenShare();
        });
    }
    
    indicator.style.display = 'block';
}

function hideOwnScreenShareIndicator() {
    const indicator = document.getElementById('ownScreenShareIndicator');
    if (indicator) {
        indicator.remove();
    }
}

async function renegotiateConnection() {
    if (!globalPeerConnection) return;
    
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
        console.error('Ошибка пересоздания offer:', err);
    }
}

function stopScreenShare() {
    if (!isScreenSharing) return;
    
    console.log('Остановка демонстрации экрана');
    isScreenSharing = false;
    
    if (screenShareStream) {
        screenShareStream.getTracks().forEach(track => track.stop());
        screenShareStream = null;
    }
    
    if (globalPeerConnection) {
        const senders = globalPeerConnection.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender && videoSender.track) {
            videoSender.track.stop();
        }
    }
    
    hideOwnScreenShareIndicator();
    
    if (socket && globalCurrentCallId) {
        socket.emit('screen_share_stopped', {
            call_id: globalCurrentCallId,
            sender_id: currentUserId
        });
    }
    
    updateScreenShareButton(false);
    renegotiateConnection();
    
    showNotification('Демонстрация экрана', 'Демонстрация остановлена');
}

function updateScreenShareButton(isSharing) {
    const screenShareBtn = document.getElementById('discordScreenShareBtn');
    if (screenShareBtn) {
        if (isSharing) {
            screenShareBtn.textContent = '🖥️✖';
            screenShareBtn.title = 'Остановить демонстрацию экрана';
            screenShareBtn.classList.add('active');
        } else {
            screenShareBtn.textContent = '🖥️';
            screenShareBtn.title = 'Начать демонстрацию экрана';
            screenShareBtn.classList.remove('active');
        }
    }
}

function endGlobalCall() {
    stopPingMeasurement();
    
    if (isScreenSharing) {
        stopScreenShare();
    }
    
    // Скрываем демонстрацию экрана собеседника
    hideScreenShareInChat();
    isRemoteScreenSharing = false;
    screenShareManuallyClosed = false;
    
    if (screenShareStreams.has('context')) {
        screenShareStreams.get('context').close();
        screenShareStreams.clear();
    }
    
    if (socket && globalCurrentCallId && isCallActive) {
        socket.emit('end_call', { call_id: globalCurrentCallId });
    }
    
    if (globalPeerConnection) {
        globalPeerConnection.close();
        globalPeerConnection = null;
    }
    
    if (globalLocalStream) {
        globalLocalStream.getTracks().forEach(track => track.stop());
        globalLocalStream = null;
    }
    
    const globalCallWidget = document.getElementById('globalCallWidget');
    if (globalCallWidget) globalCallWidget.style.display = 'none';
    
    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'none';
    
    hideDiscordCallPanel();
    
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) {
        if (audioElement.srcObject) {
            audioElement.srcObject.getTracks().forEach(track => track.stop());
        }
        audioElement.remove();
    }
    
    remoteScreenShareStream = null;
    
    globalCurrentCallId = null;
    globalCurrentCallType = null;
    isCallActive = false;
    hasAcceptedCall = false;
    isMuted = false;
    isSpeakerOff = false;
    isScreenSharing = false;
    screenShareStream = null;
    screenShareSender = null;
    window.currentCallPeerId = null;
    window.currentCallPeerUsername = null;
    currentRemoteAudioElement = null;
    currentRemoteStream = null;
}

function showNotification(title, message) {
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

// ========== ФУНКЦИИ ДЛЯ ПИНГА ==========

function startPingMeasurement() {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
        if (globalPeerConnection && globalPeerConnection.connectionState === 'connected') {
            measurePing();
        }
    }, 2000);
}

function stopPingMeasurement() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

async function measurePing() {
    if (!globalPeerConnection) return;
    
    try {
        const stats = await globalPeerConnection.getStats();
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
                currentPing = Math.round(report.currentRoundTripTime * 1000);
                updatePingDisplay(currentPing);
            }
        });
    } catch (err) {
        console.error('Ошибка измерения пинга:', err);
    }
}

function updatePingDisplay(ping) {
    const pingContainer = document.getElementById('discordPingContainer');
    if (!pingContainer) return;
    
    let color = '#2ecc71';
    if (ping >= 100 && ping < 200) color = '#f1c40f';
    else if (ping >= 200) color = '#e74c3c';
    
    pingContainer.innerHTML = '';
    
    const maxDivisions = 6;
    const divisionValue = 50;
    
    for (let i = 0; i < maxDivisions; i++) {
        const division = document.createElement('div');
        division.className = 'ping-division';
        
        let divisionColor = '#2ecc71';
        if (i * divisionValue >= 100 && i * divisionValue < 200) divisionColor = '#f1c40f';
        else if (i * divisionValue >= 200) divisionColor = '#e74c3c';
        
        division.style.backgroundColor = (ping > i * divisionValue) ? divisionColor : '#4a4a4a';
        division.title = `${i * divisionValue}-${(i + 1) * divisionValue} мс`;
        
        if (ping > i * divisionValue && ping <= (i + 1) * divisionValue) {
            division.classList.add('active');
            division.title = `${ping} мс`;
        }
        
        pingContainer.appendChild(division);
    }
    
    const pingValueSpan = document.createElement('span');
    pingValueSpan.className = 'ping-value';
    pingValueSpan.textContent = `${ping} мс`;
    pingValueSpan.style.color = color;
    pingContainer.appendChild(pingValueSpan);
}

function showDiscordCallPanel() {
    hideDiscordCallPanel();
    
    const panel = document.createElement('div');
    panel.id = 'discordCallPanel';
    panel.className = 'discord-call-panel';
    
    panel.innerHTML = `
        <div class="discord-call-container">
            <div class="discord-call-users">
                <div class="discord-user my-user">
                    <div class="discord-user-avatar" id="discordMyAvatar">
                        ${document.querySelector('.avatar-circle')?.textContent || '?'}
                    </div>
                    <span class="discord-user-name">${document.querySelector('.username')?.textContent || 'Вы'}</span>
                </div>
                <div class="discord-call-status">
                    <div class="discord-ping" id="discordPingContainer">
                        <div class="ping-division"></div>
                        <div class="ping-division"></div>
                        <div class="ping-division"></div>
                        <div class="ping-division"></div>
                        <div class="ping-division"></div>
                        <div class="ping-division"></div>
                        <span class="ping-value">0 мс</span>
                    </div>
                </div>
                <div class="discord-user peer-user" id="discordPeerUser">
                    <div class="discord-user-avatar" id="discordPeerAvatar">
                        ${window.currentCallPeerUsername ? window.currentCallPeerUsername[0].toUpperCase() : '?'}
                    </div>
                    <span class="discord-user-name" id="discordPeerName">${window.currentCallPeerUsername || 'Собеседник'}</span>
                </div>
            </div>
            <div class="discord-call-controls">
                <button class="discord-control-btn" id="discordScreenShareBtn" title="Начать демонстрацию экрана">🖥️</button>
                <button class="discord-control-btn" id="discordMuteBtn" title="Отключить микрофон">🎤</button>
                <button class="discord-control-btn" id="discordSpeakerBtn" title="Отключить звук собеседника">🔊</button>
                <button class="discord-control-btn discord-end-call" id="discordEndCallBtn" title="Завершить звонок">📞</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(panel);
    
    document.getElementById('discordScreenShareBtn')?.addEventListener('click', startScreenShare);
    document.getElementById('discordMuteBtn')?.addEventListener('click', () => {
        toggleMute();
        document.getElementById('discordMuteBtn').textContent = isMuted ? '🔇' : '🎤';
    });
    document.getElementById('discordSpeakerBtn')?.addEventListener('click', () => {
        toggleSpeaker();
        document.getElementById('discordSpeakerBtn').textContent = isSpeakerOff ? '🔇' : '🔊';
    });
    document.getElementById('discordEndCallBtn')?.addEventListener('click', endGlobalCall);
    document.getElementById('discordPeerUser')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showVolumeSlider(e, window.currentCallPeerId, window.currentCallPeerUsername, 'peer');
    });
}

function hideDiscordCallPanel() {
    const panel = document.getElementById('discordCallPanel');
    if (panel) panel.remove();
    const contextMenu = document.getElementById('volumeContextMenu');
    if (contextMenu) contextMenu.remove();
}

function showVolumeSlider(event, userId, username, type) {
    const existingMenu = document.getElementById('volumeContextMenu');
    if (existingMenu) existingMenu.remove();
    
    const menu = document.createElement('div');
    menu.id = 'volumeContextMenu';
    menu.className = 'volume-context-menu';
    menu.style.left = `${event.pageX}px`;
    menu.style.top = `${event.pageY}px`;
    
    let currentVolume = 100;
    if (userId && remoteAudioGains.has(userId)) {
        currentVolume = remoteAudioGains.get(userId);
    } else if (currentRemoteAudioElement) {
        currentVolume = Math.round(currentRemoteAudioElement.volume * 100);
    }
    
    menu.innerHTML = `
        <div class="volume-menu-header"><span>🔊 Громкость ${escapeHtml(username)}</span></div>
        <div class="volume-slider-container">
            <span class="volume-icon">🔈</span>
            <input type="range" id="volumeSlider" class="volume-slider" min="0" max="200" value="${currentVolume}" step="1">
            <span class="volume-icon">🔊</span>
        </div>
        <div class="volume-value" id="volumeValue">${currentVolume}%</div>
        <div class="volume-reset-btn" id="volumeResetBtn">Сбросить (100%)</div>
    `;
    
    document.body.appendChild(menu);
    
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = `${window.innerWidth - menuRect.width - 10}px`;
    if (menuRect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - menuRect.height - 10}px`;
    
    const slider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    
    slider?.addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        volumeValue.textContent = `${volume}%`;
        setRemoteVolumeForUser(userId, volume);
    });
    
    document.getElementById('volumeResetBtn')?.addEventListener('click', () => {
        if (slider) slider.value = '100';
        if (volumeValue) volumeValue.textContent = '100%';
        setRemoteVolumeForUser(userId, 100);
    });
    
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('contextmenu', closeMenu);
        }
    };
    
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
        document.addEventListener('contextmenu', closeMenu);
    }, 100);
}

function setRemoteVolumeForUser(userId, volumePercent) {
    remoteAudioGains.set(userId, volumePercent);
    setRemoteVolume(volumePercent);
}

function setRemoteVolume(volumePercent) {
    const volume = Math.min(1, Math.max(0, volumePercent / 100));
    if (currentRemoteAudioElement) currentRemoteAudioElement.volume = volume;
}

function setupFriendContextMenu() {
    const friendItems = document.querySelectorAll('.friend-item');
    friendItems.forEach(item => {
        item.removeEventListener('contextmenu', handleFriendContextMenu);
        item.addEventListener('contextmenu', handleFriendContextMenu);
    });
    
    const observer = new MutationObserver(() => {
        document.querySelectorAll('.friend-item').forEach(item => {
            item.removeEventListener('contextmenu', handleFriendContextMenu);
            item.addEventListener('contextmenu', handleFriendContextMenu);
        });
    });
    
    const friendsList = document.getElementById('friendsList');
    if (friendsList) observer.observe(friendsList, { childList: true, subtree: true });
}

function handleFriendContextMenu(e) {
    e.preventDefault();
    const friendItem = e.target.closest('.friend-item');
    if (!friendItem) return;
    
    const friendId = parseInt(friendItem.dataset.friendId);
    const friendName = friendItem.querySelector('.friend-name')?.textContent || 'Друг';
    showVolumeSlider(e, friendId, friendName, 'friend');
}