// Глобальная переменная для Socket.IO
let socket = null;

// Инициализация Socket.IO при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
    // Инициализируем socket соединение
    socket = io();
    
    socket.on('connect', function() {
        console.log('Socket.IO connected');
    });
    
    socket.on('disconnect', function() {
        console.log('Socket.IO disconnected');
    });
});