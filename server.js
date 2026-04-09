const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });

const db = new sqlite3.Database('messenger.db');

db.serialize(() => {
    // Пользователи
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT DEFAULT '/avatars/default.png',
        role TEXT DEFAULT 'user',
        theme TEXT DEFAULT 'dark',
        banned INTEGER DEFAULT 0,
        banned_until INTEGER DEFAULT NULL,
        banned_ip TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // IP пользователей
    db.run(`CREATE TABLE IF NOT EXISTS user_ips (
        user_id TEXT,
        ip TEXT,
        last_seen INTEGER,
        PRIMARY KEY(user_id, ip)
    )`);
    
    // Коды приглашения
    db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        created_by TEXT,
        uses_left INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        voice TEXT,
        reply_to TEXT,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Непрочитанные сообщения (счётчик)
    db.run(`CREATE TABLE IF NOT EXISTS unread_counts (
        user_id TEXT,
        from_user_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, from_user_id)
    )`);
    
    // Каналы
    db.run(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        owner_id TEXT,
        verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Подписчики
    db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
        channel_id TEXT,
        user_id TEXT,
        PRIMARY KEY(channel_id, user_id)
    )`);
    
    // Заметки
    db.run(`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        content TEXT,
        pinned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Друзья
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT,
        friend_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, friend_id)
    )`);
    
    // Антиспам
    db.run(`CREATE TABLE IF NOT EXISTS spam_log (
        user_id TEXT,
        message_count INTEGER DEFAULT 1,
        last_message INTEGER,
        blocked_until INTEGER,
        PRIMARY KEY(user_id)
    )`);
    
    // Баны по IP
    db.run(`CREATE TABLE IF NOT EXISTS banned_ips (
        ip TEXT PRIMARY KEY,
        banned_at INTEGER,
        reason TEXT
    )`);
    
    // Создаём владельца
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'owner')", 
                ['owner_artemka', 'Artemka1488', hashedPassword]);
            console.log('✅ Владелец Artemka1488 (пароль: admin123)');
        }
    });
    
    // Код дружбы
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) {
            db.run("INSERT INTO invite_codes (code, created_by, uses_left) VALUES ('FRIEND2024', 'owner_artemka', 1000)");
        }
    });
    
    // Канал владельца
    db.get("SELECT * FROM channels WHERE name = 'Artemka1488 Official'", (err, channel) => {
        if (!channel) {
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, 1)", 
                ['channel_artemka', 'Artemka1488 Official', 'Официальный канал владельца', 'owner_artemka']);
        }
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// Получить IP
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
}

// Проверка бана
function isUserBanned(user, ip, callback) {
    const now = Date.now();
    if (user && user.banned === 1) {
        if (user.banned_until && user.banned_until > now) {
            callback(true, `Аккаунт заморожен до ${new Date(user.banned_until).toLocaleString()}`);
        } else if (user.banned_until === null || user.banned_until <= now) {
            callback(true, 'Аккаунт заблокирован навсегда');
        } else {
            callback(false, null);
        }
    } else {
        db.get("SELECT * FROM banned_ips WHERE ip = ?", [ip], (err, bannedIp) => {
            if (bannedIp) callback(true, 'Ваш IP заблокирован');
            else callback(false, null);
        });
    }
}

// ========== АНТИСПАМ ==========
function checkSpam(userId, callback) {
    const now = Date.now();
    db.get("SELECT * FROM spam_log WHERE user_id = ?", [userId], (err, log) => {
        if (log && log.blocked_until && log.blocked_until > now) {
            callback(true, Math.ceil((log.blocked_until - now) / 1000));
        } else if (log && log.last_message && (now - log.last_message) < 800) {
            let count = (log.message_count || 1) + 1;
            if (count >= 10) {
                let blockedUntil = now + 60000;
                db.run("UPDATE spam_log SET message_count = ?, last_message = ?, blocked_until = ? WHERE user_id = ?", [count, now, blockedUntil, userId]);
                callback(true, 60);
            } else {
                db.run("UPDATE spam_log SET message_count = ?, last_message = ? WHERE user_id = ?", [count, now, userId]);
                callback(false, 0);
            }
        } else {
            db.run("INSERT OR REPLACE INTO spam_log (user_id, message_count, last_message, blocked_until) VALUES (?, 1, ?, NULL)", [userId, now]);
            callback(false, 0);
        }
    });
}

// Обновить счётчик непрочитанных
function updateUnreadCount(toUserId, fromUserId) {
    db.run(`INSERT INTO unread_counts (user_id, from_user_id, count) 
            VALUES (?, ?, 1) 
            ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`, 
            [toUserId, fromUserId]);
}

// Сбросить счётчик
function resetUnreadCount(userId, fromUserId) {
    db.run("DELETE FROM unread_counts WHERE user_id = ? AND from_user_id = ?", [userId, fromUserId]);
}

// ========== API ==========

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    const ip = getClientIp(req);
    
    if (!username || username.length < 3) return res.json({ error: 'Ник от 3 символов' });
    if (!password || password.length < 4) return res.json({ error: 'Пароль от 4 символов' });
    if (!inviteCode) return res.json({ error: 'Введите код дружбы' });
    
    db.get("SELECT * FROM invite_codes WHERE code = ? AND uses_left > 0", [inviteCode], async (err, code) => {
        if (!code) return res.json({ error: 'Неверный код' });
        
        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
            if (user) return res.json({ error: 'Ник занят' });
            
            const userId = generateId();
            const hashedPassword = await bcrypt.hash(password, 10);
            
            db.run("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", [userId, username, hashedPassword]);
            db.run("INSERT INTO user_ips (user_id, ip, last_seen) VALUES (?, ?, ?)", [userId, ip, Date.now()]);
            db.run("UPDATE invite_codes SET uses_left = uses_left - 1 WHERE code = ?", [inviteCode]);
            
            res.json({ success: true, userId, username });
        });
    });
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const ip = getClientIp(req);
    
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        isUserBanned(user, ip, async (banned, reason) => {
            if (banned) return res.json({ error: reason });
            
            const valid = await bcrypt.compare(password, user.password);
            if (!valid) return res.json({ error: 'Неверный пароль' });
            
            db.run("INSERT OR REPLACE INTO user_ips (user_id, ip, last_seen) VALUES (?, ?, ?)", [user.id, ip, Date.now()]);
            res.json({ success: true, userId: user.id, username: user.username, role: user.role, theme: user.theme || 'dark' });
        });
    });
});

// ========== АДМИН-ФУНКЦИИ (только владелец) ==========

// Бан пользователя
app.post('/api/admin/ban-user', (req, res) => {
    const { adminId, userId, reason, duration } = req.body; // duration: null=навсегда, число=минут
    
    db.get("SELECT role FROM users WHERE id = ?", [adminId], (err, admin) => {
        if (!admin || admin.role !== 'owner') return res.json({ error: 'Нет прав' });
        
        const bannedUntil = duration ? Date.now() + (duration * 60000) : null;
        db.run("UPDATE users SET banned = 1, banned_until = ? WHERE id = ?", [bannedUntil, userId]);
        
        // Кикаем пользователя
        const userSocket = onlineUsers.get(userId);
        if (userSocket) {
            io.to(userSocket.socketId).emit('force-logout', { reason: `Вы забанены: ${reason}` });
        }
        
        res.json({ success: true });
    });
});

// Разбан
app.post('/api/admin/unban-user', (req, res) => {
    const { adminId, userId } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [adminId], (err, admin) => {
        if (!admin || admin.role !== 'owner') return res.json({ error: 'Нет прав' });
        
        db.run("UPDATE users SET banned = 0, banned_until = NULL WHERE id = ?", [userId]);
        res.json({ success: true });
    });
});

// Бан по IP
app.post('/api/admin/ban-ip', (req, res) => {
    const { adminId, ip, reason } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [adminId], (err, admin) => {
        if (!admin || admin.role !== 'owner') return res.json({ error: 'Нет прав' });
        
        db.run("INSERT OR REPLACE INTO banned_ips (ip, banned_at, reason) VALUES (?, ?, ?)", [ip, Date.now(), reason]);
        
        // Кикаем всех с этим IP
        for (let [userId, data] of onlineUsers) {
            db.get("SELECT ip FROM user_ips WHERE user_id = ?", [userId], (err, ipData) => {
                if (ipData && ipData.ip === ip) {
                    io.to(data.socketId).emit('force-logout', { reason: `Ваш IP заблокирован: ${reason}` });
                }
            });
        }
        
        res.json({ success: true });
    });
});

// Удалить аккаунт
app.post('/api/admin/delete-user', (req, res) => {
    const { adminId, userId } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [adminId], (err, admin) => {
        if (!admin || admin.role !== 'owner') return res.json({ error: 'Нет прав' });
        
        db.run("DELETE FROM users WHERE id = ?", [userId]);
        db.run("DELETE FROM messages WHERE from_id = ? OR to_id = ?", [userId, userId]);
        db.run("DELETE FROM friends WHERE user_id = ? OR friend_id = ?", [userId, userId]);
        db.run("DELETE FROM notes WHERE user_id = ?", [userId]);
        
        const userSocket = onlineUsers.get(userId);
        if (userSocket) {
            io.to(userSocket.socketId).emit('force-logout', { reason: 'Ваш аккаунт удалён' });
        }
        
        res.json({ success: true });
    });
});

// Получить всех пользователей (для админа)
app.get('/api/admin/users', (req, res) => {
    const { adminId } = req.query;
    
    db.get("SELECT role FROM users WHERE id = ?", [adminId], (err, admin) => {
        if (!admin || admin.role !== 'owner') return res.json({ error: 'Нет прав' });
        
        db.all(`SELECT u.*, 
                (SELECT COUNT(*) FROM messages WHERE to_id = u.id AND read = 0) as unread,
                (SELECT ip FROM user_ips WHERE user_id = u.id ORDER BY last_seen DESC LIMIT 1) as last_ip
                FROM users u`, [], (err, users) => {
            res.json({ users: users || [] });
        });
    });
});

// ========== ОСТАЛЬНЫЕ API ==========

// Обновление темы
app.post('/api/update-theme', (req, res) => {
    const { userId, theme } = req.body;
    db.run("UPDATE users SET theme = ? WHERE id = ?", [theme, userId]);
    res.json({ success: true });
});

// Получить каналы
app.get('/api/channels', (req, res) => {
    db.all(`SELECT c.*, u.username as owner_name FROM channels c 
            JOIN users u ON u.id = c.owner_id 
            ORDER BY c.verified DESC, c.created_at DESC`, [], (err, channels) => {
        res.json({ channels: channels || [] });
    });
});

// Создать канал
app.post('/api/create-channel', (req, res) => {
    const { name, description, userId } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (user && user.role === 'owner') {
            const channelId = generateId();
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, 1)", 
                [channelId, name, description, userId]);
            res.json({ success: true });
        } else {
            res.json({ error: 'Только владелец' });
        }
    });
});

// Подписаться
app.post('/api/subscribe-channel', (req, res) => {
    const { channelId, userId } = req.body;
    db.run("INSERT OR IGNORE INTO channel_subscribers (channel_id, user_id) VALUES (?, ?)", [channelId, userId]);
    res.json({ success: true });
});

// Заметки
app.get('/api/notes/:userId', (req, res) => {
    db.all("SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, created_at DESC", [req.params.userId], (err, notes) => {
        res.json({ notes: notes || [] });
    });
});

app.post('/api/create-note', (req, res) => {
    const { userId, title, content } = req.body;
    const noteId = generateId();
    db.run("INSERT INTO notes (id, user_id, title, content) VALUES (?, ?, ?, ?)", [noteId, userId, title, content]);
    res.json({ success: true });
});

app.post('/api/pin-note', (req, res) => {
    const { noteId, pinned } = req.body;
    db.run("UPDATE notes SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, noteId]);
    res.json({ success: true });
});

app.post('/api/delete-note', (req, res) => {
    const { noteId } = req.body;
    db.run("DELETE FROM notes WHERE id = ?", [noteId]);
    res.json({ success: true });
});

// Друзья
app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    
    db.get("SELECT id, username FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        
        db.get("SELECT * FROM friends WHERE user_id = ? AND friend_id = ?", [userId, friend.id], (err, existing) => {
            if (existing) return res.json({ error: 'Уже в друзьях' });
            
            db.run("INSERT INTO friends (user_id, friend_id) VALUES (?, ?)", [userId, friend.id]);
            db.run("INSERT INTO friends (user_id, friend_id) VALUES (?, ?)", [friend.id, userId]);
            
            res.json({ success: true, message: `${friend.username} добавлен!` });
        });
    });
});

app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.avatar,
            (SELECT COUNT(*) FROM unread_counts WHERE user_id = ? AND from_user_id = u.id) as unread_count
            FROM friends f 
            JOIN users u ON u.id = f.friend_id 
            WHERE f.user_id = ?`, [req.params.userId, req.params.userId], (err, friends) => {
        res.json({ friends: friends || [] });
    });
});

app.get('/api/unread-count/:userId/:fromUserId', (req, res) => {
    db.get("SELECT count FROM unread_counts WHERE user_id = ? AND from_user_id = ?", 
        [req.params.userId, req.params.fromUserId], (err, data) => {
        res.json({ count: data?.count || 0 });
    });
});

// Получить сообщения
app.get('/api/messages/:userId/:otherId', (req, res) => {
    resetUnreadCount(req.params.userId, req.params.otherId);
    
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 100`, 
        [req.params.userId, req.params.otherId, req.params.otherId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Голосовое
app.post('/api/voice-message', (req, res) => {
    const { audioData } = req.body;
    const filename = `${Date.now()}.webm`;
    const filepath = `/voice/${filename}`;
    const buffer = Buffer.from(audioData.split(',')[1], 'base64');
    fs.writeFileSync(`./public${filepath}`, buffer);
    res.json({ success: true, url: filepath });
});

// ========== WEBSOCKET ==========
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUserId = null;
    
    socket.on('user-online', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, { socketId: socket.id, username: data.username });
        broadcastUsers();
    });
    
    socket.on('private-message', (data) => {
        checkSpam(currentUserId, (isBlocked, secondsLeft) => {
            if (isBlocked) {
                socket.emit('spam-warning', { message: `Блок спама: ${secondsLeft} сек` });
                return;
            }
            
            const messageId = generateId();
            db.run(`INSERT INTO messages (id, from_id, to_id, text, voice, reply_to) 
                    VALUES (?, ?, ?, ?, ?, ?)`, 
                [messageId, currentUserId, data.toUserId, data.text, data.voice, data.replyTo ? JSON.stringify(data.replyTo) : null]);
            
            // Обновляем счётчик непрочитанных
            updateUnreadCount(data.toUserId, currentUserId);
            
            const toUser = onlineUsers.get(data.toUserId);
            if (toUser) {
                io.to(toUser.socketId).emit('new-message', {
                    id: messageId,
                    fromId: currentUserId,
                    text: data.text,
                    voice: data.voice,
                    replyTo: data.replyTo,
                    time: new Date().toLocaleTimeString()
                });
                // Отправляем обновление счётчика
                db.get("SELECT count FROM unread_counts WHERE user_id = ? AND from_user_id = ?", 
                    [data.toUserId, currentUserId], (err, countData) => {
                    io.to(toUser.socketId).emit('unread-update', { fromUserId: currentUserId, count: countData?.count || 1 });
                });
            }
            socket.emit('message-sent', { id: messageId });
        });
    });
    
    // Звонки
    socket.on('call-user', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('incoming-call', {
                fromId: currentUserId,
                fromName: data.fromName,
                offer: data.offer,
                type: data.type
            });
        }
    });
    
    socket.on('answer-call', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) io.to(toUser.socketId).emit('call-answered', { answer: data.answer });
    });
    
    socket.on('ice-candidate', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) io.to(toUser.socketId).emit('ice-candidate', { candidate: data.candidate });
    });
    
    socket.on('end-call', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) io.to(toUser.socketId).emit('call-ended');
    });
    
    socket.on('typing', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) io.to(toUser.socketId).emit('user-typing', { fromId: currentUserId, name: data.name });
    });
    
    socket.on('disconnect', () => {
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            broadcastUsers();
        }
    });
    
    function broadcastUsers() {
        const list = [];
        for (let [id, data] of onlineUsers) {
            list.push({ id: id, username: data.username, online: true });
        }
        io.emit('users-list', list);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер на порту ${PORT}`));
