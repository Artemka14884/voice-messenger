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

if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });

const db = new sqlite3.Database('messenger.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
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
        }
    });
    
    // Код дружбы
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) {
            db.run("INSERT INTO invite_codes (code, uses_left) VALUES ('FRIEND2024', 10000)");
        }
    });
});

function generateId() { return Date.now().toString(36); }

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
        res.json({ success: true, userId: user.id, username: user.username, role: user.role });
    });
});

app.get('/api/users', (req, res) => {
    db.all("SELECT id, username, online FROM users", [], (err, users) => {
        res.json({ users: users || [] });
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

app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.online,
            (SELECT count FROM unread WHERE user_id = ? AND from_id = u.id) as unread
            FROM users u WHERE u.id != ?`, [req.params.userId, req.params.userId], (err, users) => {
        res.json({ friends: users || [] });
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
        currentUser = { id: data.userId, name: data.username };
        onlineUsers.set(data.userId, { socketId: socket.id, name: data.username });
        
        // Отправляем список онлайн
        const list = [];
        for (let [id, user] of onlineUsers) {
            list.push({ id, name: user.name });
        }
        io.emit('online-list', list);
    });
    
    // Обычное сообщение
    socket.on('message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO messages (id, from_id, to_id, text) VALUES (?, ?, ?, ?)", 
            [messageId, currentUser.id, data.to, data.text]);
        
        db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, 
                [data.to, currentUser.id]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('message', {
                id: messageId,
                from: currentUser.id,
                fromName: currentUser.name,
                text: data.text,
                time: time
            });
            
            db.get("SELECT count FROM unread WHERE user_id = ? AND from_id = ?", [data.to, currentUser.id], (err, cnt) => {
                io.to(toUser.socketId).emit('unread-update', { fromId: currentUser.id, count: cnt?.count || 1 });
            });
        }
        
        socket.emit('message-sent', { id: messageId, text: data.text, time: time });
    });
    
    // Голосовое сообщение
    socket.on('voice-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO messages (id, from_id, to_id, voice) VALUES (?, ?, ?, ?)", 
            [messageId, currentUser.id, data.to, data.voiceUrl]);
        
        db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, 
                [data.to, currentUser.id]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('voice-message', {
                id: messageId,
                from: currentUser.id,
                fromName: currentUser.name,
                voiceUrl: data.voiceUrl,
                time: time
            });
            
            db.get("SELECT count FROM unread WHERE user_id = ? AND from_id = ?", [data.to, currentUser.id], (err, cnt) => {
                io.to(toUser.socketId).emit('unread-update', { fromId: currentUser.id, count: cnt?.count || 1 });
            });
        }
    });
    
    // ========== ЗВОНКИ ==========
    socket.on('call-user', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('incoming-call', {
                fromId: currentUser.id,
                fromName: currentUser.name,
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
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('typing', { from: currentUser.name });
        }
    });
    
    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser.id);
            db.run("UPDATE users SET online = 0 WHERE id = ?", [currentUser.id]);
            
            const list = [];
            for (let [id, user] of onlineUsers) {
                list.push({ id, name: user.name });
            }
            io.emit('online-list', list);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
