// Глобальные переменные для WebRTC
let globalPeerConnection = null;
let globalCurrentCallId = null;
let globalCurrentCallType = null;
let globalLocalStream = null;
let isMuted = false;
let isSpeakerOff = false;
let isCallActive = false; // Добавляем флаг активного звонка
let hasAcceptedCall = false; // Флаг, принят ли звонок

// Новые переменные для пинга и громкости
let pingInterval = null;
let currentPing = 0;
let remoteAudioGains = new Map(); // Хранилище уровней громкости для разных пользователей
let currentRemoteAudioElement = null;
let currentRemoteStream = null;

// STUN/TURN серверы - используем конфигурацию из HTML
let configuration = {
    iceServers: [
        { urls: window.STUN_URL}
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
            // Запускаем измерение пинга
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
    
    // Сохраняем ID собеседника для звонка
    window.currentCallPeerId = currentChatId;
    window.currentCallPeerUsername = currentChatUsername;
    
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
                // Запускаем измерение пинга
                startPingMeasurement();
                // Показываем Discord-подобную панель звонка
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
        document.body.appendChild(audioElement);
    }
    audioElement.srcObject = stream;
    currentRemoteAudioElement = audioElement;
    currentRemoteStream = stream;
    
    // Применяем сохраненную громкость для этого пользователя
    if (window.currentCallPeerId && remoteAudioGains.has(window.currentCallPeerId)) {
        const gainValue = remoteAudioGains.get(window.currentCallPeerId);
        setRemoteVolume(gainValue);
    }
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
    
    // Обновляем иконку в Discord-панели
    const panelMuteBtn = document.getElementById('discordMuteBtn');
    if (panelMuteBtn) panelMuteBtn.textContent = isMuted ? '🔇' : '🎤';
}

function toggleSpeaker() {
    isSpeakerOff = !isSpeakerOff;
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) {
        audioElement.muted = isSpeakerOff;
    }
    const speakerBtn = document.getElementById('speakerBtn');
    if (speakerBtn) speakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
    
    // Обновляем иконку в Discord-панели
    const panelSpeakerBtn = document.getElementById('discordSpeakerBtn');
    if (panelSpeakerBtn) panelSpeakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
}

function endGlobalCall() {
    // Останавливаем измерение пинга
    stopPingMeasurement();
    
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
    
    // Скрываем Discord-подобную панель
    hideDiscordCallPanel();
    
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
    window.currentCallPeerId = null;
    window.currentCallPeerUsername = null;
    currentRemoteAudioElement = null;
    currentRemoteStream = null;
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

// ========== НОВЫЕ ФУНКЦИИ ДЛЯ ПИНГА И УПРАВЛЕНИЯ ГРОМКОСТЬЮ ==========

// Запуск измерения пинга
function startPingMeasurement() {
    if (pingInterval) {
        clearInterval(pingInterval);
    }
    
    // Измеряем пинг каждые 2 секунды
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

// Измерение пинга через WebRTC (используем RTCIceCandidatePair stats)
async function measurePing() {
    if (!globalPeerConnection) return;
    
    try {
        const stats = await globalPeerConnection.getStats();
        let currentRoundTripTime = null;
        
        stats.forEach(report => {
            // Ищем кандидатную пару с типом 'candidate-pair' и состоянием 'succeeded'
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                if (report.currentRoundTripTime !== undefined && report.currentRoundTripTime > 0) {
                    currentRoundTripTime = report.currentRoundTripTime * 1000; // в миллисекундах
                }
            }
            // Альтернативный способ через remote-candidate
            if (report.type === 'remote-candidate' && report.lastPacketReceivedTimestamp) {
                // Не используем этот метод, т.к. он не дает точного RTT
            }
        });
        
        if (currentRoundTripTime) {
            currentPing = Math.round(currentRoundTripTime);
            updatePingDisplay(currentPing);
        }
    } catch (err) {
        console.error('Ошибка измерения пинга:', err);
    }
}

// Обновление отображения пинга
function updatePingDisplay(ping) {
    const pingContainer = document.getElementById('discordPingContainer');
    if (!pingContainer) return;
    
    // Определяем цвет
    let color = '#2ecc71'; // зеленый (менее 100)
    if (ping >= 100 && ping < 200) {
        color = '#f1c40f'; // желтый
    } else if (ping >= 200) {
        color = '#e74c3c'; // красный
    }
    
    // Очищаем контейнер
    pingContainer.innerHTML = '';
    
    // Создаем деления (по 50 мс каждое, максимум 6 делений = 300 мс)
    const maxDivisions = 6;
    const divisionValue = 50; // 50 мс на деление
    
    for (let i = 0; i < maxDivisions; i++) {
        const division = document.createElement('div');
        division.className = 'ping-division';
        
        const divisionStart = i * divisionValue;
        const divisionEnd = (i + 1) * divisionValue;
        
        // Определяем цвет деления
        let divisionColor = '#2ecc71';
        if (divisionStart >= 100 && divisionStart < 200) {
            divisionColor = '#f1c40f';
        } else if (divisionStart >= 200) {
            divisionColor = '#e74c3c';
        }
        
        division.style.backgroundColor = (ping > divisionStart) ? divisionColor : '#4a4a4a';
        
        // Добавляем подсказку при наведении
        division.title = `${divisionStart}-${divisionEnd} мс`;
        
        // Если это активное деление (где находится текущий пинг), выделяем его
        if (ping > divisionStart && ping <= divisionEnd) {
            division.classList.add('active');
            division.title = `${ping} мс`;
        }
        
        pingContainer.appendChild(division);
    }
    
    // Добавляем числовое значение пинга
    const pingValueSpan = document.createElement('span');
    pingValueSpan.className = 'ping-value';
    pingValueSpan.textContent = `${ping} мс`;
    pingValueSpan.style.color = color;
    pingContainer.appendChild(pingValueSpan);
}

// Discord-подобная панель звонка
function showDiscordCallPanel() {
    // Удаляем существующую панель если есть
    hideDiscordCallPanel();
    
    // Создаем панель
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
                <button class="discord-control-btn" id="discordMuteBtn" title="Отключить микрофон">🎤</button>
                <button class="discord-control-btn" id="discordSpeakerBtn" title="Отключить звук собеседника">🔊</button>
                <button class="discord-control-btn discord-end-call" id="discordEndCallBtn" title="Завершить звонок">📞</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(panel);
    
    // Добавляем обработчики
    const muteBtn = document.getElementById('discordMuteBtn');
    const speakerBtn = document.getElementById('discordSpeakerBtn');
    const endCallBtn = document.getElementById('discordEndCallBtn');
    const peerAvatar = document.getElementById('discordPeerUser');
    
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            toggleMute();
            muteBtn.textContent = isMuted ? '🔇' : '🎤';
        });
    }
    
    if (speakerBtn) {
        speakerBtn.addEventListener('click', () => {
            toggleSpeaker();
            speakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
        });
    }
    
    if (endCallBtn) {
        endCallBtn.addEventListener('click', () => {
            endGlobalCall();
        });
    }
    
    // Контекстное меню для аватара собеседника
    if (peerAvatar) {
        peerAvatar.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showVolumeSlider(e, window.currentCallPeerId, window.currentCallPeerUsername, 'peer');
        });
    }
    
    // Обновляем состояние кнопок
    if (muteBtn) muteBtn.textContent = isMuted ? '🔇' : '🎤';
    if (speakerBtn) speakerBtn.textContent = isSpeakerOff ? '🔇' : '🔊';
}

function hideDiscordCallPanel() {
    const panel = document.getElementById('discordCallPanel');
    if (panel) {
        panel.remove();
    }
    // Удаляем контекстные меню, если есть
    const contextMenu = document.getElementById('volumeContextMenu');
    if (contextMenu) contextMenu.remove();
}

// Показать слайдер громкости
function showVolumeSlider(event, userId, username, type) {
    // Удаляем существующее меню
    const existingMenu = document.getElementById('volumeContextMenu');
    if (existingMenu) existingMenu.remove();
    
    // Создаем меню
    const menu = document.createElement('div');
    menu.id = 'volumeContextMenu';
    menu.className = 'volume-context-menu';
    menu.style.left = `${event.pageX}px`;
    menu.style.top = `${event.pageY}px`;
    
    // Получаем текущую громкость
    let currentVolume = 100;
    if (userId && remoteAudioGains.has(userId)) {
        currentVolume = remoteAudioGains.get(userId);
    } else if (currentRemoteAudioElement) {
        // Если есть прямой элемент audio, берем громкость оттуда
        currentVolume = Math.round(currentRemoteAudioElement.volume * 100);
    }
    
    menu.innerHTML = `
        <div class="volume-menu-header">
            <span>🔊 Громкость ${escapeHtml(username)}</span>
        </div>
        <div class="volume-slider-container">
            <span class="volume-icon">🔈</span>
            <input type="range" id="volumeSlider" class="volume-slider" min="0" max="200" value="${currentVolume}" step="1">
            <span class="volume-icon">🔊</span>
        </div>
        <div class="volume-value" id="volumeValue">${currentVolume}%</div>
        <div class="volume-reset-btn" id="volumeResetBtn">Сбросить (100%)</div>
    `;
    
    document.body.appendChild(menu);
    
    // Позиционирование с учетом границ экрана
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - menuRect.width - 10}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - menuRect.height - 10}px`;
    }
    
    // Обработчик слайдера
    const slider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    
    if (slider) {
        slider.addEventListener('input', (e) => {
            const volume = parseInt(e.target.value);
            volumeValue.textContent = `${volume}%`;
            setRemoteVolumeForUser(userId, volume);
        });
    }
    
    // Кнопка сброса
    const resetBtn = document.getElementById('volumeResetBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (slider) slider.value = '100';
            if (volumeValue) volumeValue.textContent = '100%';
            setRemoteVolumeForUser(userId, 100);
        });
    }
    
    // Закрытие при клике вне меню
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

// Установка громкости для конкретного пользователя
function setRemoteVolumeForUser(userId, volumePercent) {
    // Сохраняем значение
    remoteAudioGains.set(userId, volumePercent);
    
    // Применяем громкость
    setRemoteVolume(volumePercent);
}

// Установка громкости для текущего аудио элемента
function setRemoteVolume(volumePercent) {
    const volume = Math.min(1, Math.max(0, volumePercent / 100));
    
    if (currentRemoteAudioElement) {
        currentRemoteAudioElement.volume = volume;
    }
}

// Обновляем openChat для добавления контекстного меню на друзей
// Эта функция будет вызвана из index.html
function setupFriendContextMenu() {
    // Добавляем контекстное меню для друзей в списке
    const friendItems = document.querySelectorAll('.friend-item');
    friendItems.forEach(item => {
        item.removeEventListener('contextmenu', handleFriendContextMenu);
        item.addEventListener('contextmenu', handleFriendContextMenu);
    });
    
    // Наблюдатель за изменениями списка друзей
    const observer = new MutationObserver(() => {
        const newFriendItems = document.querySelectorAll('.friend-item');
        newFriendItems.forEach(item => {
            item.removeEventListener('contextmenu', handleFriendContextMenu);
            item.addEventListener('contextmenu', handleFriendContextMenu);
        });
    });
    
    const friendsList = document.getElementById('friendsList');
    if (friendsList) {
        observer.observe(friendsList, { childList: true, subtree: true });
    }
}

function handleFriendContextMenu(e) {
    e.preventDefault();
    const friendItem = e.target.closest('.friend-item');
    if (!friendItem) return;
    
    const friendId = parseInt(friendItem.dataset.friendId);
    const friendName = friendItem.querySelector('.friend-name')?.textContent || 'Друг';
    
    // Показываем слайдер громкости для этого друга
    showVolumeSlider(e, friendId, friendName, 'friend');
}