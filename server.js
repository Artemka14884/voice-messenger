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
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// Создаём папки
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') cb(null, './public/avatars');
        else cb(null, './public/uploads');
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

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
        avatar TEXT DEFAULT '/avatars/group.png',
        owner_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Участники групп
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT,
        user_id TEXT,
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
    
    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        file TEXT,
        type TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Групповые сообщения
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        from_id TEXT,
        text TEXT,
        file TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения каналов
    db.run(`CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT,
        from_id TEXT,
        text TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    
    // Непрочитанные
    db.run(`CREATE TABLE IF NOT EXISTS unread (
        user_id TEXT,
        from_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(user_id, from_id)
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
            console.log('✅ Artemka1488 / admin123');
        }
    });
    
    // Демо группа
    db.get("SELECT * FROM groups WHERE name = 'Общий чат'", (err, group) => {
        if (!group) {
            db.run("INSERT INTO groups (id, name, owner_id) VALUES ('group1', 'Общий чат', 'owner1')");
        }
    });
    
    // Код
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

// Загрузка файла
app.post('/api/upload-file', upload.single('file'), (req, res) => {
    const fileUrl = '/uploads/' + req.file.filename;
    const isImage = req.file.mimetype.startsWith('image/');
    res.json({ success: true, url: fileUrl, name: req.file.originalname, isImage });
});

// Получить пользователей
app.get('/api/users/:userId', (req, res) => {
    db.all("SELECT id, username, online, avatar, role FROM users WHERE id != ?", [req.params.userId], (err, users) => {
        res.json({ users: users || [] });
    });
});

// Получить группы пользователя
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
    const { name, userId } = req.body;
    const groupId = generateId();
    db.run("INSERT INTO groups (id, name, owner_id) VALUES (?, ?, ?)", [groupId, name, userId]);
    db.run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", [groupId, userId]);
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

// Получить каналы
app.get('/api/channels', (req, res) => {
    db.all(`SELECT c.*, u.username as owner_name 
            FROM channels c 
            JOIN users u ON u.id = c.owner_id 
            ORDER BY c.verified DESC, c.subscribers DESC`, [], (err, channels) => {
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
            res.json({ success: true });
        } else {
            res.json({ error: 'Только владелец может создавать каналы' });
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

// Групповые сообщения
app.get('/api/group-messages/:groupId', (req, res) => {
    db.all(`SELECT gm.*, u.username, u.avatar 
            FROM group_messages gm
            JOIN users u ON u.id = gm.from_id
            WHERE gm.group_id = ?
            ORDER BY gm.created_at ASC LIMIT 200`, [req.params.groupId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Сообщения каналов
app.get('/api/channel-messages/:channelId', (req, res) => {
    db.all(`SELECT cm.*, u.username, u.avatar 
            FROM channel_messages cm
            JOIN users u ON u.id = cm.from_id
            WHERE cm.channel_id = ?
            ORDER BY cm.created_at ASC LIMIT 200`, [req.params.channelId], (err, messages) => {
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

// ========== WEBSOCKET ==========
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUserId = null;
    
    socket.on('login', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, { socketId: socket.id, name: data.username, avatar: data.avatar });
        
        const list = [];
        for (let [id, user] of onlineUsers) {
            list.push({ id, name: user.name, avatar: user.avatar });
        }
        io.emit('online-list', list);
    });
    
    // Личное сообщение
    socket.on('message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO messages (id, from_id, to_id, text, file, type, time) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [messageId, currentUserId, data.to, data.text || null, data.file || null, data.fileType || null, time]);
        
        // Обновляем непрочитанные
        db.run(`INSERT INTO unread (user_id, from_id, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, from_id) DO UPDATE SET count = count + 1`, [data.to, currentUserId]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('new-message', {
                id: messageId,
                from: currentUserId,
                text: data.text,
                file: data.file,
                fileType: data.fileType,
                time: time
            });
            
            db.get("SELECT count FROM unread WHERE user_id = ? AND from_id = ?", [data.to, currentUserId], (err, cnt) => {
                io.to(toUser.socketId).emit('unread-update', { fromId: currentUserId, count: cnt?.count || 1 });
            });
        }
        
        socket.emit('message-sent', { id: messageId, text: data.text, file: data.file, time: time });
    });
    
    // Групповое сообщение
    socket.on('group-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO group_messages (id, group_id, from_id, text, file, time) VALUES (?, ?, ?, ?, ?, ?)", 
            [messageId, data.groupId, currentUserId, data.text || null, data.file || null, time]);
        
        db.all("SELECT user_id FROM group_members WHERE group_id = ?", [data.groupId], (err, members) => {
            members.forEach(member => {
                const memberSocket = onlineUsers.get(member.user_id);
                if (memberSocket && member.user_id !== currentUserId) {
                    io.to(memberSocket.socketId).emit('new-group-message', {
                        id: messageId,
                        groupId: data.groupId,
                        from: currentUserId,
                        text: data.text,
                        file: data.file,
                        fileType: data.fileType,
                        time: time
                    });
                }
            });
        });
    });
    
    // Сообщение в канал
    socket.on('channel-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO channel_messages (id, channel_id, from_id, text, time) VALUES (?, ?, ?, ?, ?)", 
            [messageId, data.channelId, currentUserId, data.text, time]);
        
        db.all("SELECT user_id FROM channel_subs WHERE channel_id = ?", [data.channelId], (err, subs) => {
            subs.forEach(sub => {
                const subSocket = onlineUsers.get(sub.user_id);
                if (subSocket && sub.user_id !== currentUserId) {
                    io.to(subSocket.socketId).emit('new-channel-message', {
                        id: messageId,
                        channelId: data.channelId,
                        from: currentUserId,
                        text: data.text,
                        time: time
                    });
                }
            });
        });
    });
    
    // Печатает
    socket.on('typing', (data) => {
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('typing', { from: data.name });
        }
    });
    
    socket.on('disconnect', () => {
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            db.run("UPDATE users SET online = 0 WHERE id = ?", [currentUserId]);
            const list = [];
            for (let [id, user] of onlineUsers) {
                list.push({ id, name: user.name, avatar: user.avatar });
            }
            io.emit('online-list', list);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
