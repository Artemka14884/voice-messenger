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

// Загрузка аватарок
const storage = multer.diskStorage({
    destination: './public/avatars/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

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
        online INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Группы
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT,
        avatar TEXT DEFAULT '/avatars/group_default.png',
        description TEXT,
        owner_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Участники групп
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT,
        user_id TEXT,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(group_id, user_id)
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
    
    // Сообщения (личные)
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
    
    // Сообщения в группах
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        from_id TEXT,
        text TEXT,
        voice TEXT,
        reply_to TEXT,
        reactions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения в каналах
    db.run(`CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT,
        from_id TEXT,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Непрочитанные
    db.run(`CREATE TABLE IF NOT EXISTS unread (
        user_id TEXT,
        from_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, from_id)
    )`);
    
    // Заметки
    db.run(`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        content TEXT,
        color TEXT DEFAULT '#2d2d5e',
        pinned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Коды приглашения
    db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        uses_left INTEGER DEFAULT 1
    )`);
    
    // Владелец
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password, role) VALUES ('owner1', 'Artemka1488', ?, 'owner')", [hash]);
            console.log('✅ Владелец создан: Artemka1488 / admin123');
        }
    });
    
    // Демо группа
    db.get("SELECT * FROM groups WHERE name = 'Общий чат'", (err, group) => {
        if (!group) {
            db.run("INSERT INTO groups (id, name, description, owner_id) VALUES ('group1', 'Общий чат', 'Главная группа для общения', 'owner1')");
        }
    });
    
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) db.run("INSERT INTO invite_codes (code, uses_left) VALUES ('FRIEND2024', 10000)");
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// ========== API ==========

// Регистрация
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
            
            // Добавляем в общую группу
            db.run("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('group1', ?)", [userId]);
            
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
        db.run("UPDATE users SET online = 1 WHERE id = ?", [user.id]);
        res.json({ success: true, userId: user.id, username: user.username, role: user.role, avatar: user.avatar });
    });
});

// Загрузка аватарки
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    const avatarUrl = '/avatars/' + req.file.filename;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, userId]);
    res.json({ success: true, avatar: avatarUrl });
});

// Получить пользователей
app.get('/api/users', (req, res) => {
    db.all("SELECT id, username, online, avatar FROM users", [], (err, users) => {
        res.json({ users: users || [] });
    });
});

// Добавить друга
app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    db.get("SELECT id, username FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        if (userId === friend.id) return res.json({ error: 'Нельзя добавить себя' });
        res.json({ success: true, friend: { id: friend.id, username: friend.username } });
    });
});

// Получить друзей
app.get('/api/friends/:userId', (req, res) => {
    db.all(`SELECT u.id, u.username, u.online, u.avatar,
            (SELECT count FROM unread WHERE user_id = ? AND from_id = u.id) as unread
            FROM users u WHERE u.id != ?`, [req.params.userId, req.params.userId], (err, users) => {
        res.json({ friends: users || [] });
    });
});

// Группы пользователя
app.get('/api/groups/:userId', (req, res) => {
    db.all(`SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as members
            FROM groups g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.user_id = ?`, [req.params.userId], (err, groups) => {
        res.json({ groups: groups || [] });
    });
});

// Создать группу
app.post('/api/create-group', (req, res) => {
    const { name, description, userId } = req.body;
    const groupId = generateId();
    db.run("INSERT INTO groups (id, name, description, owner_id) VALUES (?, ?, ?, ?)", [groupId, name, description, userId]);
    db.run("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')", [groupId, userId]);
    res.json({ success: true, groupId });
});

// Добавить в группу
app.post('/api/add-to-group', (req, res) => {
    const { groupId, username } = req.body;
    db.get("SELECT id FROM users WHERE username = ?", [username], (err, user) => {
        if (user) {
            db.run("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)", [groupId, user.id]);
            res.json({ success: true });
        } else {
            res.json({ error: 'Пользователь не найден' });
        }
    });
});

// Сообщения в группе
app.get('/api/group-messages/:groupId', (req, res) => {
    db.all(`SELECT gm.*, u.username, u.avatar 
            FROM group_messages gm
            JOIN users u ON u.id = gm.from_id
            WHERE gm.group_id = ?
            ORDER BY gm.created_at ASC LIMIT 200`, [req.params.groupId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Каналы
app.get('/api/channels', (req, res) => {
    db.all(`SELECT c.*, u.username as owner_name 
            FROM channels c 
            JOIN users u ON u.id = c.owner_id 
            ORDER BY c.verified DESC, c.subscribers DESC`, [], (err, channels) => {
        res.json({ channels: channels || [] });
    });
});

// Создать канал
app.post('/api/create-channel', (req, res) => {
    const { name, description, userId } = req.body;
    db.get("SELECT role FROM users WHERE id = ?", [userId], (err, user) => {
        if (user && (user.role === 'owner' || user.role === 'admin')) {
            const channelId = generateId();
            db.run("INSERT INTO channels (id, name, description, owner_id, verified) VALUES (?, ?, ?, ?, ?)", 
                [channelId, name, description, userId, user.role === 'owner' ? 1 : 0]);
            res.json({ success: true });
        } else {
            res.json({ error: 'Нет прав' });
        }
    });
});

// Подписаться на канал
app.post('/api/subscribe-channel', (req, res) => {
    const { channelId, userId } = req.body;
    db.run("INSERT OR IGNORE INTO channel_subs (channel_id, user_id) VALUES (?, ?)", [channelId, userId]);
    db.run("UPDATE channels SET subscribers = (SELECT COUNT(*) FROM channel_subs WHERE channel_id = ?) WHERE id = ?", [channelId, channelId]);
    res.json({ success: true });
});

// Сообщения в канале
app.get('/api/channel-messages/:channelId', (req, res) => {
    db.all(`SELECT cm.*, u.username, u.avatar 
            FROM channel_messages cm
            JOIN users u ON u.id = cm.from_id
            WHERE cm.channel_id = ?
            ORDER BY cm.created_at ASC LIMIT 200`, [req.params.channelId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Личные сообщения
app.get('/api/messages/:userId/:friendId', (req, res) => {
    db.run("DELETE FROM unread WHERE user_id = ? AND from_id = ?", [req.params.userId, req.params.friendId]);
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 200`, 
        [req.params.userId, req.params.friendId, req.params.friendId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Заметки
app.get('/api/notes/:userId', (req, res) => {
    db.all("SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, created_at DESC", [req.params.userId], (err, notes) => {
        res.json({ notes: notes || [] });
    });
});

app.post('/api/create-note', (req, res) => {
    const { userId, title, content, color } = req.body;
    const noteId = generateId();
    db.run("INSERT INTO notes (id, user_id, title, content, color) VALUES (?, ?, ?, ?, ?)", [noteId, userId, title, content, color || '#2d2d5e']);
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

// Голосовое
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
        io.emit('online-list', Array.from(onlineUsers.values()).map(u => ({ id: u.id, name: u.name })));
    });
    
    // Личное сообщение
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
                id: messageId, from: currentUser.id, fromName: currentUser.name, fromAvatar: data.fromAvatar,
                text: data.text, replyTo: data.replyTo, time: time
            });
        }
        socket.emit('message-sent', { id: messageId, text: data.text, time: time });
    });
    
    // Групповое сообщение
    socket.on('group-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        db.run("INSERT INTO group_messages (id, group_id, from_id, text, reply_to) VALUES (?, ?, ?, ?, ?)", 
            [messageId, data.groupId, currentUser.id, data.text, data.replyTo || null]);
        
        db.all("SELECT user_id FROM group_members WHERE group_id = ?", [data.groupId], (err, members) => {
            members.forEach(member => {
                const memberSocket = onlineUsers.get(member.user_id);
                if (memberSocket) {
                    io.to(memberSocket.socketId).emit('group-message', {
                        id: messageId, groupId: data.groupId, from: currentUser.id, fromName: currentUser.name,
                        text: data.text, replyTo: data.replyTo, time: time
                    });
                }
            });
        });
        socket.emit('message-sent', { id: messageId, text: data.text, time: time });
    });
    
    // Сообщение в канал
    socket.on('channel-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        db.run("INSERT INTO channel_messages (id, channel_id, from_id, text) VALUES (?, ?, ?, ?)", 
            [messageId, data.channelId, currentUser.id, data.text]);
        
        db.all("SELECT user_id FROM channel_subs WHERE channel_id = ?", [data.channelId], (err, subs) => {
            subs.forEach(sub => {
                const subSocket = onlineUsers.get(sub.user_id);
                if (subSocket) {
                    io.to(subSocket.socketId).emit('channel-message', {
                        id: messageId, channelId: data.channelId, from: currentUser.id, fromName: currentUser.name,
                        text: data.text, time: time
                    });
                }
            });
        });
    });
    
    // Голосовое
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
    
    // Реакция
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
                fromId: currentUser.id, fromName: currentUser.name,
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
            io.emit('online-list', Array.from(onlineUsers.values()).map(u => ({ id: u.id, name: u.name })));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
