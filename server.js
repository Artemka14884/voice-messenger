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

// Создаём папки
if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });

// ========== БАЗА ДАННЫХ ==========
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Код дружбы
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
        reactions TEXT,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    
    // Подписчики каналов
    db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
        channel_id TEXT,
        user_id TEXT,
        role TEXT DEFAULT 'subscriber',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, friend_id)
    )`);
    
    // Заявки в друзья
    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id TEXT,
        to_user_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Создаём владельца Artemka1488
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'owner')", 
                ['owner_artemka', 'Artemka1488', hashedPassword]);
            console.log('✅ Создан владелец Artemka1488 с паролем admin123');
        }
    });
    
    // Создаём тестового пользователя
    db.get("SELECT * FROM users WHERE username = 'TestUser'", async (err, user) => {
        if (!user) {
            const hashedPassword = await bcrypt.hash('test123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'user')", 
                ['test_user', 'TestUser', hashedPassword]);
        }
    });
    
    // Создаём код дружбы
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) {
            db.run("INSERT INTO invite_codes (code, created_by, uses_left) VALUES ('FRIEND2024', 'owner_artemka', 100)");
        }
    });
    
    // Создаём канал владельца с галочкой
    db.get("SELECT * FROM channels WHERE name = 'Artemka1488 Official'", (err, channel) => {
        if (!channel) {
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, 1)", 
                ['channel_artemka', 'Artemka1488 Official', 'Официальный канал владельца', 'owner_artemka']);
            console.log('✅ Создан канал Artemka1488 Official');
        }
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// ========== API ==========

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    if (!username || username.length < 3) return res.json({ error: 'Ник от 3 символов' });
    if (!password || password.length < 4) return res.json({ error: 'Пароль от 4 символов' });
    if (!inviteCode) return res.json({ error: 'Введите код дружбы' });
    
    db.get("SELECT * FROM invite_codes WHERE code = ? AND uses_left > 0", [inviteCode], async (err, code) => {
        if (err || !code) return res.json({ error: 'Неверный код дружбы' });
        
        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
            if (user) return res.json({ error: 'Ник уже занят' });
            
            const userId = generateId();
            const hashedPassword = await bcrypt.hash(password, 10);
            
            db.run("INSERT INTO users (id, username, password) VALUES (?, ?, ?)", [userId, username, hashedPassword]);
            db.run("UPDATE invite_codes SET uses_left = uses_left - 1 WHERE code = ?", [inviteCode]);
            
            res.json({ success: true, userId, username });
        });
    });
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err || !user) return res.json({ error: 'Пользователь не найден' });
        
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

// Получить каналы
app.get('/api/channels', (req, res) => {
    db.all(`SELECT c.*, u.username as owner_name FROM channels c 
            JOIN users u ON u.id = c.owner_id 
            ORDER BY c.verified DESC, c.created_at DESC`, [], (err, channels) => {
        res.json({ channels: channels || [] });
    });
});

// Создать канал (только владелец)
app.post('/api/create-channel', (req, res) => {
    const { name, description, userId } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (user && user.role === 'owner') {
            const channelId = generateId();
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, 1)", 
                [channelId, name, description, userId]);
            res.json({ success: true, channelId });
        } else {
            res.json({ error: 'Только владелец может создавать каналы' });
        }
    });
});

// Получить заметки
app.get('/api/notes/:userId', (req, res) => {
    db.all("SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, created_at DESC", [req.params.userId], (err, notes) => {
        res.json({ notes: notes || [] });
    });
});

// Создать заметку
app.post('/api/create-note', (req, res) => {
    const { userId, title, content } = req.body;
    const noteId = generateId();
    db.run("INSERT INTO notes (id, user_id, title, content) VALUES (?, ?, ?, ?)", [noteId, userId, title, content]);
    res.json({ success: true });
});

// Закрепить заметку
app.post('/api/pin-note', (req, res) => {
    const { noteId, pinned } = req.body;
    db.run("UPDATE notes SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, noteId]);
    res.json({ success: true });
});

// Удалить заметку
app.post('/api/delete-note', (req, res) => {
    const { noteId } = req.body;
    db.run("DELETE FROM notes WHERE id = ?", [noteId]);
    res.json({ success: true });
});

// Отправить заявку в друзья
app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    db.get("SELECT id, username FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        
        db.get("SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?", [userId, friend.id], (err, existing) => {
            if (existing) return res.json({ error: 'Заявка уже отправлена' });
            
            db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES (?, ?, 'pending')", [userId, friend.id]);
            res.json({ success: true, message: 'Заявка отправлена' });
        });
    });
});

// Получить заявки в друзья
app.get('/api/friend-requests/:userId', (req, res) => {
    db.all(`SELECT fr.*, u.username as from_name 
            FROM friend_requests fr 
            JOIN users u ON u.id = fr.from_user_id 
            WHERE fr.to_user_id = ? AND fr.status = 'pending'`, 
        [req.params.userId], (err, requests) => {
        res.json({ requests: requests || [] });
    });
});

// Принять заявку
app.post('/api/accept-friend', (req, res) => {
    const { userId, fromUserId } = req.body;
    db.run("UPDATE friend_requests SET status = 'accepted' WHERE from_user_id = ? AND to_user_id = ?", [fromUserId, userId]);
    db.run("INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')", [userId, fromUserId]);
    db.run("INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'accepted')", [fromUserId, userId]);
    res.json({ success: true });
});

// Получить друзей
app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.avatar 
            FROM friends f 
            JOIN users u ON u.id = f.friend_id 
            WHERE f.user_id = ? AND f.status = 'accepted'`, 
        [req.params.userId], (err, friends) => {
        res.json({ friends: friends || [] });
    });
});

// Получить сообщения
app.get('/api/messages/:userId/:otherId', (req, res) => {
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 100`, 
        [req.params.userId, req.params.otherId, req.params.otherId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Голосовое сообщение
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
        const messageId = generateId();
        db.run(`INSERT INTO messages (id, from_id, to_id, text, voice, reply_to) 
                VALUES (?, ?, ?, ?, ?, ?)`, 
            [messageId, currentUserId, data.toUserId, data.text, data.voice, data.replyTo ? JSON.stringify(data.replyTo) : null]);
        
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
        }
        socket.emit('message-sent', { id: messageId });
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
        if (toUser) {
            io.to(toUser.socketId).emit('call-answered', { answer: data.answer });
        }
    });
    
    socket.on('ice-candidate', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('ice-candidate', { candidate: data.candidate });
        }
    });
    
    socket.on('end-call', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('call-ended');
        }
    });
    
    socket.on('typing', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('user-typing', { fromId: currentUserId, name: data.name });
        }
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
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
