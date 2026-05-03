// Глобальные переменные для WebRTC
let globalPeerConnection = null;
let globalCurrentCallId = null;
let globalCurrentCallType = null;
let globalLocalStream = null;
let isMuted = false;
let isSpeakerOff = false;

// STUN/TURN серверы
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
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
        showGlobalCallModal(data);
    });

    socket.on('call_initialized', (data) => {
        console.log('Звонок инициализирован:', data);
        if (!globalCurrentCallId) {
            globalCurrentCallId = data.call_id;
            if (globalPeerConnection && globalLocalStream) {
                createAndSendOffer();
            }
            showGlobalCallWidget('outgoing');
        }
    });

    socket.on('call_accepted', (data) => {
        console.log('Звонок принят:', data);
        if (data.call_id === globalCurrentCallId) {
            updateCallWidgetStatus('Разговор');
        }
    });

    socket.on('call_rejected', (data) => {
        console.log('Звонок отклонен:', data);
        if (data.call_id === globalCurrentCallId) {
            updateCallWidgetStatus('Звонок отклонен');
            setTimeout(() => endGlobalCall(), 2000);
        }
    });

    socket.on('call_ended', (data) => {
        console.log('Звонок завершен:', data);
        if (data.call_id === globalCurrentCallId) {
            updateCallWidgetStatus('Звонок завершен');
            setTimeout(() => endGlobalCall(), 2000);
        }
    });

    // WebRTC сигналинг
    socket.on('webrtc_offer', async (data) => {
        console.log('Получен offer:', data);
        if (data.call_id === globalCurrentCallId) {
            await handleRemoteOffer(data);
        }
    });

    socket.on('webrtc_answer', async (data) => {
        console.log('Получен answer:', data);
        if (data.call_id === globalCurrentCallId && globalPeerConnection) {
            await globalPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    });

    socket.on('webrtc_ice_candidate', async (data) => {
        if (data.call_id === globalCurrentCallId && globalPeerConnection && data.candidate) {
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
    globalCurrentCallId = data.call_id;
    globalCurrentCallType = data.call_type;

    const modalCallerName = document.getElementById('modalCallerName');
    const modalCallStatus = document.getElementById('modalCallStatus');
    const modalCallAvatar = document.getElementById('modalCallAvatar');
    
    if (modalCallerName) modalCallerName.textContent = `Входящий звонок от ${data.caller_name}`;
    if (modalCallStatus) modalCallStatus.textContent = 'Звонок...';
    if (modalCallAvatar) modalCallAvatar.innerHTML = data.call_type === 'video' ? '📹' : '🎤';
    
    const modalCallButtons = document.getElementById('modalCallButtons');
    if (modalCallButtons) {
        modalCallButtons.innerHTML = `
            <button class="accept-call" onclick="acceptCallFromModal()">Принять</button>
            <button class="reject-call" onclick="rejectCallFromModal()">Отклонить</button>
        `;
    }

    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'flex';

    // Запрашиваем доступ к медиа-устройствам
    const constraints = data.call_type === 'video'
        ? { audio: true, video: true }
        : { audio: true, video: false };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            console.log('Локальный поток готов');
            if (data.call_type === 'video') {
                const modalLocalVideo = document.getElementById('modalLocalVideo');
                const modalVideoContainer = document.getElementById('modalVideoContainer');
                const modalCallAvatarElem = document.getElementById('modalCallAvatar');
                
                if (modalLocalVideo) modalLocalVideo.srcObject = stream;
                if (modalVideoContainer) modalVideoContainer.style.display = 'flex';
                if (modalCallAvatarElem) modalCallAvatarElem.style.display = 'none';
            }
        })
        .catch(err => {
            console.error('Ошибка доступа к устройствам:', err);
            alert('Не удалось получить доступ к камере/микрофону. Пожалуйста, проверьте разрешения.');
            rejectCallFromModal();
        });
}

function acceptCallFromModal() {
    if (!globalLocalStream) {
        alert('Медиа-устройства еще не готовы. Пожалуйста, подождите.');
        return;
    }

    if (!globalPeerConnection) {
        createGlobalPeerConnection();
    }

    // Добавляем треки в пир-соединение
    if (globalPeerConnection && globalPeerConnection.getSenders().length === 0) {
        globalLocalStream.getTracks().forEach(track => {
            globalPeerConnection.addTrack(track, globalLocalStream);
        });
    }

    // Отправляем сигнал accept_call
    if (socket) {
        socket.emit('accept_call', { call_id: globalCurrentCallId });
    }
    
    // Скрываем модальное окно и показываем виджет
    const globalCallModal = document.getElementById('globalCallModal');
    if (globalCallModal) globalCallModal.style.display = 'none';
    showGlobalCallWidget('active');
    updateCallWidgetStatus('Соединение...');
}

function rejectCallFromModal() {
    if (socket) {
        socket.emit('reject_call', { call_id: globalCurrentCallId });
    }
    closeGlobalCallModal();
    stopLocalStream();
}

function closeGlobalCallModal() {
    const globalCallModal = document.getElementById('globalCallModal');
    const modalVideoContainer = document.getElementById('modalVideoContainer');
    const modalCallAvatar = document.getElementById('modalCallAvatar');
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
    
    globalCurrentCallType = type;
    
    const constraints = type === 'video' 
        ? { audio: true, video: true }
        : { audio: true, video: false };
    
    navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
            globalLocalStream = stream;
            createGlobalPeerConnection();
            
            // Добавляем треки
            if (globalPeerConnection) {
                stream.getTracks().forEach(track => {
                    globalPeerConnection.addTrack(track, stream);
                });
            }

            // Отправляем запрос на звонок
            socket.emit('call_user', {
                receiver_id: currentChatId,
                call_type: type
            });

            showGlobalCallWidget('outgoing');
        })
        .catch(err => {
            console.error('Ошибка доступа к устройствам:', err);
            alert('Не удалось получить доступ к камере/микрофону. Пожалуйста, проверьте разрешения.');
        });
}

function createGlobalPeerConnection() {
    globalPeerConnection = new RTCPeerConnection(configuration);
    
    globalPeerConnection.onicecandidate = (event) => {
        if (event.candidate && socket && globalCurrentCallId) {
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
        if (globalLocalStream) {
            globalLocalStream.getTracks().forEach(track => {
                globalPeerConnection.addTrack(track, globalLocalStream);
            });
        }
    }

    try {
        const offer = await globalPeerConnection.createOffer();
        await globalPeerConnection.setLocalDescription(offer);
        
        if (socket && globalCurrentCallId) {
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
        if (globalLocalStream) {
            globalLocalStream.getTracks().forEach(track => {
                globalPeerConnection.addTrack(track, globalLocalStream);
            });
        }
    }

    try {
        await globalPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await globalPeerConnection.createAnswer();
        await globalPeerConnection.setLocalDescription(answer);
        
        if (socket) {
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
    if (globalPeerConnection) {
        globalPeerConnection.close();
        globalPeerConnection = null;
    }
    
    stopLocalStream();
    
    if (socket && globalCurrentCallId) {
        socket.emit('end_call', { call_id: globalCurrentCallId });
    }
    
    // Скрываем виджет и модальное окно
    const globalCallWidget = document.getElementById('globalCallWidget');
    if (globalCallWidget) globalCallWidget.style.display = 'none';
    closeGlobalCallModal();
    
    // Очищаем аудио/видео элементы
    const audioElement = document.getElementById('globalRemoteAudio');
    if (audioElement) audioElement.remove();
    
    const videoElement = document.getElementById('globalRemoteVideo');
    if (videoElement) videoElement.remove();
    
    globalCurrentCallId = null;
    globalCurrentCallType = null;
    isMuted = false;
    isSpeakerOff = false;
}

function stopLocalStream() {
    if (globalLocalStream) {
        globalLocalStream.getTracks().forEach(track => track.stop());
        globalLocalStream = null;
    }
}