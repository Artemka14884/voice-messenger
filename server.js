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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Код дружбы (для регистрации)
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
    
    // Создаём владельца (Artemka1488)
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'owner')", 
                ['owner_artemka', 'Artemka1488', hashedPassword]);
        }
    });
    
    // Создаём код дружбы по умолчанию
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) {
            db.run("INSERT INTO invite_codes (code, created_by, uses_left) VALUES ('FRIEND2024', 'owner_artemka', 100)");
        }
    });
});

// ========== ФУНКЦИИ ==========
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// ========== API ==========

// Регистрация с кодом дружбы
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    
    if (!username || username.length < 3) return res.json({ error: 'Ник от 3 символов' });
    if (!password || password.length < 4) return res.json({ error: 'Пароль от 4 символов' });
    if (!inviteCode) return res.json({ error: 'Введите код дружбы' });
    
    // Проверяем код
    db.get("SELECT * FROM invite_codes WHERE code = ? AND uses_left > 0", [inviteCode], async (err, code) => {
        if (!code) return res.json({ error: 'Неверный или использованный код дружбы' });
        
        // Проверяем существует ли пользователь
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
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.json({ error: 'Неверный пароль' });
        
        res.json({ success: true, userId: user.id, username: user.username, role: user.role, avatar: user.avatar });
    });
});

// Получить каналы
app.get('/api/channels', (req, res) => {
    db.all(`SELECT c.*, u.username as owner_name FROM channels c 
            JOIN users u ON u.id = c.owner_id 
            ORDER BY c.verified DESC, c.created_at DESC`, [], (err, channels) => {
        res.json({ channels: channels || [] });
    });
});

// Создать канал (только для владельца)
app.post('/api/create-channel', (req, res) => {
    const { name, description, userId } = req.body;
    
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (user && (user.role === 'owner' || user.role === 'admin')) {
            const channelId = generateId();
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, ?)", 
                [channelId, name, description, userId, user.role === 'owner' ? 1 : 0]);
            res.json({ success: true, channelId });
        } else {
            res.json({ error: 'Нет прав для создания канала' });
        }
    });
});

// Подписаться на канал
app.post('/api/subscribe-channel', (req, res) => {
    const { channelId, userId } = req.body;
    db.run("INSERT OR IGNORE INTO channel_subscribers (channel_id, user_id) VALUES (?, ?)", [channelId, userId]);
    res.json({ success: true });
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
    res.json({ success: true, noteId });
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
    db.get("SELECT id FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        db.run("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", [userId, friend.id]);
        res.json({ success: true });
    });
});

// Принять заявку
app.post('/api/accept-friend', (req, res) => {
    const { userId, friendId } = req.body;
    db.run("UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?", [friendId, userId]);
    res.json({ success: true });
});

// Получить друзей
app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.avatar, f.status 
            FROM friends f JOIN users u ON u.id = f.friend_id 
            WHERE f.user_id = ? AND f.status = 'accepted'`, [req.params.userId], (err, friends) => {
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

// ========== WEBSOCKET (ЗВОНКИ) ==========
const onlineUsers = new Map();
const usersData = new Map();

io.on('connection', (socket) => {
    console.log('Подключился:', socket.id);
    let currentUserId = null;
    
    socket.on('user-online', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, socket.id);
        usersData.set(data.userId, data);
        broadcastUsers();
    });
    
    // Личное сообщение
    socket.on('private-message', (data) => {
        const messageId = generateId();
        db.run(`INSERT INTO messages (id, from_id, to_id, text, voice, reply_to, reactions) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [messageId, currentUserId, data.toUserId, data.text, data.voice, JSON.stringify(data.replyTo), '{}']);
        
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('new-message', {
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
    
    // ========== ЗВОНКИ (WebRTC) ==========
    socket.on('call-user', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('incoming-call', {
                fromId: currentUserId,
                fromName: data.fromName,
                offer: data.offer,
                type: data.type
            });
        }
    });
    
    socket.on('answer-call', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('call-answered', { answer: data.answer });
        }
    });
    
    socket.on('ice-candidate', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('ice-candidate', { candidate: data.candidate });
        }
    });
    
    socket.on('end-call', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('call-ended');
        }
    });
    
    // Реакция
    socket.on('add-reaction', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('reaction-added', {
                messageId: data.messageId,
                reaction: data.reaction,
                fromId: currentUserId
            });
        }
    });
    
    // Печатает
    socket.on('typing', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('user-typing', { fromId: currentUserId, name: data.name });
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
        for (let [id, socketId] of onlineUsers) {
            const userData = usersData.get(id);
            if (userData) {
                list.push({ id: userData.userId, username: userData.username, online: true });
            }
        }
        io.emit('users-list', list);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
