// message-cache.js — локальный кэш переписки (localStorage)
//
// После доставки сообщения удаляются с сервера. История диалогов хранится
// на устройствах участников. Здесь — простой кэш последних сообщений по каждому
// собеседнику (с ограничением размера).

window.MsgCache = (function () {
    const PREFIX = 'diskordik_msgs_';
    const LIMIT = 500;

    function key(friendId) { return PREFIX + friendId; }

    function read(friendId) {
        try { return JSON.parse(localStorage.getItem(key(friendId)) || '[]'); }
        catch (e) { return []; }
    }

    function write(friendId, arr) {
        try {
            if (arr.length > LIMIT) arr = arr.slice(arr.length - LIMIT);
            localStorage.setItem(key(friendId), JSON.stringify(arr));
        } catch (e) {
            console.warn('Не удалось сохранить кэш сообщений:', e);
        }
    }

    function add(friendId, msg) {
        if (!msg || !msg.id) return read(friendId);
        const arr = read(friendId);
        if (arr.some(m => m.id === msg.id)) return arr;
        arr.push(msg);
        write(friendId, arr);
        return arr;
    }

    function getAll(friendId) { return read(friendId); }

    function last(friendId) {
        const arr = read(friendId);
        return arr.length ? arr[arr.length - 1] : null;
    }

    function clear(friendId) { localStorage.removeItem(key(friendId)); }

    return { add, getAll, last, clear };
})();
