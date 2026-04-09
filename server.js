const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// Папки
if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });

const db = new sqlite3.Database('messenger.db');

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
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
        muted INTEGER DEFAULT 0,
        muted_until INTEGER DEFAULT NULL,
        warnings INTEGER DEFAULT 0,
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
    
    // Непрочитанные
    db.run(`CREATE TABLE IF NOT EXISTS unread (
        user_id TEXT,
        from_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, from_id)
    )`);
    
    // Каналы
    db.run(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        owner_id TEXT,
        verified INTEGER DEFAULT 0,
        subscribers INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Подписчики каналов
    db.run(`CREATE TABLE IF NOT EXISTS channel_subs (
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
    
    // Заявки в друзья
    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT,
        to_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Жалобы на сообщения
    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        reporter_id TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Лог действий модераторов
    db.run(`CREATE TABLE IF NOT EXISTS mod_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        moderator_id TEXT,
        action TEXT,
        target_id TEXT,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Коды приглашения
    db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        created_by TEXT,
        uses_left INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Чёрный список слов
    db.run(`CREATE TABLE IF NOT EXISTS banned_words (
        word TEXT PRIMARY KEY,
        added_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // ========== ДЕФОЛТНЫЕ ДАННЫЕ ==========
    
    // Создаём владельца Artemka1488
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES ('owner_art', 'Artemka1488', ?, 'owner')", [hash]);
            console.log('✅ Создан владелец: Artemka1488 / admin123');
        }
    });
    
    // Создаём модератора
    db.get("SELECT * FROM users WHERE username = 'Moderator'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('mod123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES ('mod1', 'Moderator', ?, 'moderator')", [hash]);
            console.log('✅ Создан модератор: Moderator / mod123');
        }
    });
    
    // Код дружбы
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) {
            db.run("INSERT INTO invite_codes (code, created_by, uses_left) VALUES ('FRIEND2024', 'owner_art', 10000)");
        }
    });
    
    // Канал владельца
    db.get("SELECT * FROM channels WHERE name = 'Artemka1488 Official'", (err, channel) => {
        if (!channel) {
            db.run("INSERT INTO channels (id, name, description, owner_id, verified, subscribers) VALUES (?, ?, ?, ?, 1, 0)", 
                ['ch_art', 'Artemka1488 Official', 'Официальный канал владельца ✅', 'owner_art']);
        }
    });
    
    // Чёрный список слов
    const badWords = ['хуй', 'пизда', 'бля', 'сука', 'ебать', 'пидор', 'гандон', 'мудак', 'редиска'];
    badWords.forEach(word => {
        db.run("INSERT OR IGNORE INTO banned_words (word, added_by) VALUES (?, 'system')", [word]);
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// ========== ФИЛЬТР МАТА ==========
function filterMessage(text) {
    return new Promise((resolve) => {
        db.all("SELECT word FROM banned_words", [], (err, words) => {
            let filtered = text;
            if (words) {
                words.forEach(w => {
                    const regex = new RegExp(w.word, 'gi');
                    filtered = filtered.replace(regex, '***');
                });
            }
            resolve(filtered);
        });
    });
}

// ========== ПРОВЕРКА ПРАВ ==========
function checkRole(userId, requiredRole, callback) {
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (!user) callback(false);
        if (requiredRole === 'owner') callback(user.role === 'owner');
        if (requiredRole === 'moderator') callback(user.role === 'owner' || user.role === 'moderator');
        callback(false);
    });
}

// ========== API ==========

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    if (!username || username.length < 3) return res.json({ error: 'Ник от 3 символов' });
    if (!password || password.length < 4) return res.json({ error: 'Пароль от 4 символов' });
    if (!inviteCode) return res.json({ error: 'Введите код дружбы' });
    
    db.get("SELECT * FROM invite_codes WHERE code = ? AND uses_left > 0", [inviteCode], async (err, code) => {
        if (!code) return res.json({ error: 'Неверный код' });
        
        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
            if (user) return res.json({ error: 'Ник занят' });
            
            const userId = generateId();
            const hash = await bcrypt.hash(password, 10);
            db.run("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", [userId, username, hash]);
            db.run("UPDATE invite_codes SET uses_left = uses_left - 1 WHERE code = ?", [inviteCode]);
            res.json({ success: true, userId, username });
        });
    });
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.json({ error: 'Пользователь не найден' });
        if (user.banned === 1) {
            if (user.banned_until && user.banned_until > Date.now()) {
                return res.json({ error: `Аккаунт заморожен до ${new Date(user.banned_until).toLocaleString()}` });
            } else if (!user.banned_until) {
                return res.json({ error: 'Аккаунт заблокирован навсегда' });
            }
        }
        if (user.muted === 1 && user.muted_until > Date.now()) {
            return res.json({ error: `Вы замучены до ${new Date(user.muted_until).toLocaleString()}` });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.json({ error: 'Неверный пароль' });
        
        res.json({ success: true, userId: user.id, username: user.username, role: user.role, theme: user.theme || 'dark' });
    });
});

// Обновление темы
app.post('/api/update-theme', (req, res) => {
    const { userId, theme } = req.body;
    db.run("UPDATE users SET theme = ? WHERE id = ?", [theme, userId]);
    res.json({ success: true });
});

// ========== МОДЕРАЦИЯ ==========

// Выдать предупреждение
app.post('/api/mod/warn', (req, res) => {
    const { moderatorId, userId, reason } = req.body;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        db.run("UPDATE users SET warnings = warnings + 1 WHERE id = ?", [userId]);
        db.run("INSERT INTO mod_log (moderator_id, action, target_id, reason) VALUES (?, 'warn', ?, ?)", 
            [moderatorId, userId, reason]);
        
        db.get("SELECT warnings FROM users WHERE id = ?", [userId], (err, user) => {
            if (user.warnings >= 3) {
                db.run("UPDATE users SET muted = 1, muted_until = ? WHERE id = ?", [Date.now() + 86400000, userId]);
            }
        });
        
        res.json({ success: true });
    });
});

// Мут пользователя
app.post('/api/mod/mute', (req, res) => {
    const { moderatorId, userId, duration, reason } = req.body; // duration в минутах
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        const mutedUntil = duration ? Date.now() + (duration * 60000) : null;
        db.run("UPDATE users SET muted = 1, muted_until = ? WHERE id = ?", [mutedUntil, userId]);
        db.run("INSERT INTO mod_log (moderator_id, action, target_id, reason) VALUES (?, 'mute', ?, ?)", 
            [moderatorId, userId, reason]);
        res.json({ success: true });
    });
});

// Бан пользователя
app.post('/api/mod/ban', (req, res) => {
    const { moderatorId, userId, duration, reason } = req.body;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        const bannedUntil = duration ? Date.now() + (duration * 60000) : null;
        db.run("UPDATE users SET banned = 1, banned_until = ? WHERE id = ?", [bannedUntil, userId]);
        db.run("INSERT INTO mod_log (moderator_id, action, target_id, reason) VALUES (?, 'ban', ?, ?)", 
            [moderatorId, userId, reason]);
        
        const userSocket = onlineUsers.get(userId);
        if (userSocket) io.to(userSocket.socketId).emit('force-logout', { reason: `Вы забанены: ${reason}` });
        res.json({ success: true });
    });
});

// Разбан
app.post('/api/mod/unban', (req, res) => {
    const { moderatorId, userId } = req.body;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        db.run("UPDATE users SET banned = 0, banned_until = NULL WHERE id = ?", [userId]);
        db.run("INSERT INTO mod_log (moderator_id, action, target_id) VALUES (?, 'unban', ?)", [moderatorId, userId]);
        res.json({ success: true });
    });
});

// Пожаловаться на сообщение
app.post('/api/report', (req, res) => {
    const { messageId, reporterId, reason } = req.body;
    db.run("INSERT INTO reports (message_id, reporter_id, reason) VALUES (?, ?, ?)", [messageId, reporterId, reason]);
    res.json({ success: true });
});

// Получить список жалоб (для модераторов)
app.get('/api/mod/reports', (req, res) => {
    const { moderatorId } = req.query;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        db.all(`SELECT r.*, m.text, u.username as reporter_name 
                FROM reports r 
                JOIN messages m ON m.id = r.message_id
                JOIN users u ON u.id = r.reporter_id
                WHERE r.status = 'pending'`, [], (err, reports) => {
            res.json({ reports: reports || [] });
        });
    });
});

// Получить список пользователей (для модераторов)
app.get('/api/mod/users', (req, res) => {
    const { moderatorId } = req.query;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        db.all("SELECT id, username, role, banned, muted, warnings FROM users", [], (err, users) => {
            res.json({ users: users || [] });
        });
    });
});

// Добавить слово в чёрный список
app.post('/api/mod/add-bad-word', (req, res) => {
    const { moderatorId, word } = req.body;
    checkRole(moderatorId, 'moderator', (hasRight) => {
        if (!hasRight) return res.json({ error: 'Нет прав' });
        
        db.run("INSERT OR IGNORE INTO banned_words (word, added_by) VALUES (?, ?)", [word.toLowerCase(), moderatorId]);
        res.json({ success: true });
    });
});

// ========== КАНАЛЫ ==========
app.get('/api/channels', (req, res) => {
    db.all("SELECT * FROM channels ORDER BY verified DESC, subscribers DESC", [], (err, channels) => {
        res.json({ channels: channels || [] });
    });
});

app.post('/api/create-channel', (req, res) => {
    const { name, description, userId } = req.body;
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (user && (user.role === 'owner' || user.role === 'moderator')) {
            const channelId = generateId();
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, ?)", 
                [channelId, name, description, userId, user.role === 'owner' ? 1 : 0]);
            res.json({ success: true });
        } else {
            res.json({ error: 'Нет прав' });
        }
    });
});

app.post('/api/subscribe', (req, res) => {
    const { channelId, userId } = req.body;
    db.run("INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)", [channelId, userId]);
    db.run("UPDATE channels SET subscribers = (SELECT COUNT(*) FROM channel_subs WHERE channel_id = ?) WHERE id = ?", [channelId, channelId]);
    res.json({ success: true });
});

// ========== ЗАМЕТКИ ==========
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

// ========== ДРУЗЬЯ ==========
app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    
    db.get("SELECT id, username FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        
        db.get("SELECT * FROM friends WHERE user_id = ? AND friend_id = ?", [userId, friend.id], (err, existing) => {
            if (existing) return res.json({ error: 'Уже в друзьях' });
            
            db.run("INSERT INTO friends (user_id, friend_id) VALUES (?, ?)", [userId, friend.id]);
            db.run("INSERT INTO friends (user_id, friend_id) VALUES (?, ?)", [friend.id, userId]);
            res.json({ success: true, friend: { id: friend.id, username: friend.username } });
        });
    });
});

app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, 
            (SELECT count FROM unread WHERE user_id = ? AND from_id = u.id) as unread
            FROM friends f 
            JOIN users u ON u.id = f.friend_id 
            WHERE f.user_id = ?`, [req.params.userId, req.params.userId], (err, friends) => {
        res.json({ friends: friends || [] });
    });
});

// ========== СООБЩЕНИЯ ==========
app.get('/api/messages/:userId/:friendId', (req, res) => {
    db.run("DELETE FROM unread WHERE user_id = ? AND from_id = ?", [req.params.userId, req.params.friendId]);
    
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 200`, 
        [req.params.userId, req.params.friendId, req.params.friendId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

app.post('/api/voice', (req, res) => {
    const { audio } = req.body;
    const filename = `${Date.now()}.webm`;
    const buffer = Buffer.from(audio.split(',')[1], 'base64');
    fs.writeFileSync(`./public/voice/${filename}`, buffer);
    res.json({ url: `/voice/${filename}` });
});

// ========== WEBSOCKET ==========
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUser = null;
    
    socket.on('login', (data) => {
        currentUser = { id: data.userId, name: data.username };
        onlineUsers.set(data.userId, { socketId: socket.id, name: data.username });
        
        const list = [];
        for (let [id, user] of onlineUsers) {
            list.push({ id, name: user.name });
        }
        io.emit('online-list', list);
    });
    
    socket.on('message', async (data) => {
        // Проверка на мут
        db.get("SELECT muted, muted_until FROM users WHERE id = ?", [currentUser.id], async (err, user) => {
            if (user && user.muted === 1 && user.muted_until > Date.now()) {
                socket.emit('error', { message: `Вы замучены до ${new Date(user.muted_until).toLocaleString()}` });
                return;
            }
            
            const filteredText = await filterMessage(data.text);
            const messageId = generateId();
            const time = new Date().toLocaleTimeString();
            
            db.run("INSERT INTO messages (id, from_id, to_id, text) VALUES (?, ?, ?, ?)", 
                [messageId, currentUser.id, data.to, filteredText]);
            
            // Обновляем счётчик
            db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                    ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, 
                    [data.to, currentUser.id]);
            
            const toUser = onlineUsers.get(data.to);
            if (toUser) {
                io.to(toUser.socketId).emit('message', {
                    id: messageId,
                    from: currentUser.id,
                    fromName: currentUser.name,
                    text: filteredText,
                    time: time
                });
                
                db.get("SELECT count FROM unread WHERE user_id = ? AND from_id = ?", [data.to, currentUser.id], (err, cnt) => {
                    io.to(toUser.socketId).emit('unread-update', { fromId: currentUser.id, count: cnt?.count || 1 });
                });
            }
            
            socket.emit('message-sent', { id: messageId, text: filteredText, time: time });
        });
    });
    
    socket.on('typing', (data) => {
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('typing', { from: currentUser.name });
        }
    });
    
    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser.id);
            const list = [];
            for (let [id, user] of onlineUsers) {
                list.push({ id, name: user.name });
            }
            io.emit('online-list', list);
        }
    });
});

const PORT = process.env.PROCESS || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
