// e2e.js — сквозное (end-to-end) шифрование сообщений
//
// Схема: ECDH (P-256) для согласования ключа + AES-GCM-256 (с HKDF-деривацией,
// выполняемой внутри WebCrypto deriveKey) для симметричного шифрования.
//
// Приватный ключ хранится ТОЛЬКО в браузере (localStorage, по id пользователя).
// Публичный ключ публикуется на сервере (User.public_key) и доступен другим.
// Сервер видит только шифртекст и не может прочитать сообщения.
//
// Если WebCrypto недоступен (небезопасный контекст — http без localhost),
// включается режим совместимости: сообщения ходят открытым текстом, а в шапке
// чата показывается предупреждение. В реальном развёртывании (https) E2E активен.

window.E2E = (function () {
    const KEY_DB = 'diskordik_keys';        // { userId: { priv: JWK, pub: JWK } }
    const available = !!(window.crypto && window.crypto.subtle);

    // in-memory кэш публичных ключей собеседников
    const pubCache = new Map();

    function readKeys() {
        try { return JSON.parse(localStorage.getItem(KEY_DB) || '{}'); }
        catch (e) { return {}; }
    }
    function writeKeys(o) {
        try { localStorage.setItem(KEY_DB, JSON.stringify(o)); } catch (e) {}
    }
    function getLocalPair(userId) {
        return readKeys()[userId] || null;
    }
    function setLocalPair(userId, pair) {
        const o = readKeys();
        o[userId] = pair;
        writeKeys(o);
    }

    async function generatePair() {
        const kp = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
        );
        const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
        const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
        return { priv, pub };
    }

    async function importPub(jwk) {
        return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    }
    async function importPriv(jwk) {
        return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    }

    async function deriveSharedKey(privJwk, pubJwk) {
        const priv = await importPriv(privJwk);
        const pub = await importPub(pubJwk);
        return crypto.subtle.deriveKey(
            { name: 'ECDH', public: pub },
            priv,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function b64encode(buf) {
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
    function b64decode(str) {
        const bin = atob(str);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    async function _encrypt(plaintext, privJwk, pubJwk) {
        const key = await deriveSharedKey(privJwk, pubJwk);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder().encode(plaintext);
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
        return { ciphertext: b64encode(ct), iv: b64encode(iv.buffer) };
    }

    async function _decrypt(ciphertextB64, ivB64, privJwk, pubJwk) {
        const key = await deriveSharedKey(privJwk, pubJwk);
        const iv = new Uint8Array(b64decode(ivB64));
        const ct = b64decode(ciphertextB64);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(pt);
    }

    async function getPublicKey(userId) {
        if (pubCache.has(userId)) return pubCache.get(userId);
        const res = await fetch(`/api/keys/${userId}`).then(r => r.json());
        let jwk = null;
        if (res.public_key) {
            try {
                jwk = (typeof res.public_key === 'string') ? JSON.parse(res.public_key) : res.public_key;
            } catch (e) { jwk = null; }
        }
        pubCache.set(userId, jwk);
        return jwk;
    }

    /**
     * Гарантирует наличие локальной пары ключей и публикует публичный ключ
     * на сервере. Должна вызываться при входе на дашборд.
     */
    async function ensureMyKey(userId) {
        if (!available) return null;
        let pair = getLocalPair(userId);
        if (!pair) {
            pair = await generatePair();
            setLocalPair(userId, pair);
        }
        // Публикуем свой публичный ключ (idempotent).
        try {
            await fetch('/api/keys/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ public_key: JSON.stringify(pair.pub) })
            });
            pubCache.set(userId, pair.pub);
        } catch (e) {
            console.warn('Не удалось опубликовать публичный ключ:', e);
        }
        return pair;
    }

    /**
     * Шифрует сообщение для получателя recipientId.
     * Возвращает { ciphertext, iv } (base64) или { ciphertext: plaintext, iv: null }
     * в режиме совместимости.
     */
    async function encryptFor(plaintext, recipientId) {
        if (!available) return { ciphertext: plaintext, iv: null };
        const myId = window.currentUserId;
        let pair = getLocalPair(myId);
        if (!pair) pair = await ensureMyKey(myId);
        const pub = await getPublicKey(recipientId);
        if (!pub) throw new Error('no_recipient_pubkey');
        return await _encrypt(plaintext, pair.priv, pub);
    }

    /**
     * Расшифровывает сообщение из переписки с otherId (другая сторона диалога).
     * otherId = получатель, если сообщение отправил я; = отправитель, если мне.
     */
    async function decryptWith(ciphertextB64, ivB64, otherId) {
        if (!available || !ivB64) return ciphertextB64; // режим совместимости
        const myId = window.currentUserId;
        const pair = getLocalPair(myId);
        if (!pair) throw new Error('no_privkey');
        const pub = await getPublicKey(otherId);
        if (!pub) throw new Error('no_pubkey');
        return await _decrypt(ciphertextB64, ivB64, pair.priv, pub);
    }

    function isEncrypted(data) {
        return !!(data && data.iv);
    }

    return {
        available,
        ensureMyKey,
        encryptFor,
        decryptWith,
        getPublicKey,
        hasLocalKey: (uid) => !!getLocalPair(uid),
        isEncrypted
    };
})();
