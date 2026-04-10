const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// Создаём папки
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });

// Заглушка для аватарки по умолчанию
if (!fs.existsSync('./public/avatars/default.png')) {
    const defaultAvatar = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync('./public/avatars/default.png', Buffer.from(defaultAvatar, 'base64'));
}

const db = new sqlite3.Database('messenger.db');

db.serialize(() => {
    // Таблицы
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT DEFAULT '/avatars/default.png',
        role TEXT DEFAULT 'user',
        online INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
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
    
    db.run(`CREATE TABLE IF NOT EXISTS unread (
        user_id TEXT,
        from_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, from_id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        uses_left INTEGER DEFAULT 1
    )`);
    
    // Владелец
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES ('owner1', 'Artemka1488', ?, 'owner')", [hash]);
            console.log('✅ Владелец Artemka1488 / admin123');
        }
    });
    
    // Код
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) db.run("INSERT INTO invite_codes (code, uses_left) VALUES ('FRIEND2024', 10000)");
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// API
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;
    if (!username || username.length < 3) return res.json({ error: 'Ник от 3 символов' });
    if (!password || password.length < 4) return res.json({ error: 'Пароль от 4 символов' });
    
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

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.json({ error: 'Пользователь не найден' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.json({ error: 'Неверный пароль' });
        db.run("UPDATE users SET online = 1 WHERE id = ?", [user.id]);
        res.json({ success: true, userId: user.id, username: user.username, role: user.role, avatar: user.avatar });
    });
});

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    const avatarUrl = '/avatars/' + req.file.filename;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, userId]);
    res.json({ success: true, avatar: avatarUrl });
});

app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.online, u.avatar,
            (SELECT count FROM unread WHERE user_id = ? AND from_id = u.id) as unread
            FROM users u WHERE u.id != ?`, [req.params.userId, req.params.userId], (err, users) => {
        res.json({ friends: users || [] });
    });
});

app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    db.get("SELECT id, username FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        res.json({ success: true, friend: { id: friend.id, username: friend.username } });
    });
});

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
    const filepath = `/voice/${filename}`;
    const buffer = Buffer.from(audio.split(',')[1], 'base64');
    fs.writeFileSync(`./public${filepath}`, buffer);
    res.json({ url: filepath });
});

// ========== WEBSOCKET ==========
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUser = null;
    
    socket.on('login', (data) => {
        currentUser = { id: data.userId, name: data.username, avatar: data.avatar };
        onlineUsers.set(data.userId, { socketId: socket.id, name: data.username, avatar: data.avatar });
        io.emit('online-list', Array.from(onlineUsers.values()).map(u => ({ id: u.id, name: u.name, avatar: u.avatar })));
    });
    
    socket.on('message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        db.run("INSERT INTO messages (id, from_id, to_id, text, reply_to) VALUES (?, ?, ?, ?, ?)", 
            [messageId, currentUser.id, data.to, data.text, data.replyTo || null]);
        db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, [data.to, currentUser.id]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('message', {
                id: messageId, from: currentUser.id, fromName: currentUser.name, fromAvatar: currentUser.avatar,
                text: data.text, replyTo: data.replyTo, time: time
            });
        }
        socket.emit('message-sent', { id: messageId, text: data.text, time: time });
    });
    
    socket.on('voice-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        db.run("INSERT INTO messages (id, from_id, to_id, voice) VALUES (?, ?, ?, ?)", 
            [messageId, currentUser.id, data.to, data.voiceUrl]);
        db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, [data.to, currentUser.id]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('voice-message', {
                id: messageId, from: currentUser.id, fromName: currentUser.name,
                voiceUrl: data.voiceUrl, time: time
            });
        }
    });
    
    socket.on('add-reaction', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('reaction-added', {
                messageId: data.messageId, reaction: data.reaction, fromId: currentUser.id
            });
        }
    });
    
    // Звонки
    socket.on('call-user', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('incoming-call', {
                fromId: currentUser.id, fromName: currentUser.name, fromAvatar: currentUser.avatar,
                offer: data.offer, type: data.type
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
        const toUser = onlineUsers.get(data.to);
        if (toUser) io.to(toUser.socketId).emit('typing', { from: currentUser.name });
    });
    
    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser.id);
            db.run("UPDATE users SET online = 0 WHERE id = ?", [currentUser.id]);
            io.emit('online-list', Array.from(onlineUsers.values()).map(u => ({ id: u.id, name: u.name, avatar: u.avatar })));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
