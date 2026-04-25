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

// Папки
const folders = ['./public', './public/uploads', './public/avatars', './public/voice'];
folders.forEach(f => { if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true }); });

// Настройка multer для файлов и аватарок
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') cb(null, './public/avatars');
        else if (file.fieldname === 'voice') cb(null, './public/voice');
        else cb(null, './public/uploads');
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// База данных
const db = new sqlite3.Database('messenger.db');
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT DEFAULT '/avatars/default.png',
        wins INTEGER DEFAULT 0,
        online INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        file TEXT,
        file_type TEXT,
        voice TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT,
        user_id TEXT,
        PRIMARY KEY(group_id, user_id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        from_id TEXT,
        text TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        uses_left INTEGER DEFAULT 1
    )`);
    
    // Создаём владельца
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password) VALUES ('owner1', 'Artemka1488', ?)", [hash]);
            console.log('✅ Artemka1488 / admin123');
        }
    });
    
    // Демо группа
    db.get("SELECT * FROM groups WHERE name = 'Общий чат'", (err, group) => {
        if (!group) db.run("INSERT INTO groups (id, name) VALUES ('group1', 'Общий чат')");
    });
    
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) db.run("INSERT INTO invite_codes (code, uses_left) VALUES ('FRIEND2024', 10000)");
    });
});

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
            db.run("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('group1', ?)", [userId]);
            res.json({ success: true, userId, username });
        });
    });
});

// Логин
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.json({ error: 'Пользователь не найден' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.json({ error: 'Неверный пароль' });
        db.run("UPDATE users SET online = 1 WHERE id = ?", [user.id]);
        res.json({ success: true, userId: user.id, username: user.username, avatar: user.avatar, wins: user.wins || 0 });
    });
});

// Загрузка аватарки
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    const avatarUrl = '/avatars/' + req.file.filename;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, userId]);
    res.json({ success: true, avatar: avatarUrl });
});

// Загрузка файлов (фото, документы)
app.post('/api/upload-file', upload.single('file'), (req, res) => {
    const fileUrl = '/uploads/' + req.file.filename;
    const isImage = req.file.mimetype.startsWith('image/');
    res.json({ success: true, url: fileUrl, name: req.file.originalname, isImage });
});

// Загрузка голосовых сообщений
app.post('/api/voice', upload.single('voice'), (req, res) => {
    const voiceUrl = '/voice/' + req.file.filename;
    res.json({ success: true, url: voiceUrl });
});

// Получить список пользователей
app.get('/api/users/:userId', (req, res) => {
    db.all("SELECT id, username, online, avatar, wins FROM users WHERE id != ?", [req.params.userId], (err, users) => {
        res.json({ users: users || [] });
    });
});

// Получить историю сообщений
app.get('/api/messages/:userId/:friendId', (req, res) => {
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 200`, 
        [req.params.userId, req.params.friendId, req.params.friendId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// === ГРУППЫ ===
app.get('/api/groups/:userId', (req, res) => {
    db.all(`SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as members
            FROM groups g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.user_id = ?`, [req.params.userId], (err, groups) => {
        res.json({ groups: groups || [] });
    });
});

app.post('/api/create-group', (req, res) => {
    const { name, userId } = req.body;
    const groupId = generateId();
    db.run("INSERT INTO groups (id, name) VALUES (?, ?)", [groupId, name]);
    db.run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", [groupId, userId]);
    res.json({ success: true, groupId });
});

app.post('/api/join-group', (req, res) => {
    const { groupId, userId } = req.body;
    db.run("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)", [groupId, userId]);
    res.json({ success: true });
});

app.get('/api/group-messages/:groupId', (req, res) => {
    db.all(`SELECT gm.*, u.username, u.avatar 
            FROM group_messages gm
            JOIN users u ON u.id = gm.from_id
            WHERE gm.group_id = ?
            ORDER BY gm.created_at ASC LIMIT 200`, [req.params.groupId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// === ЗАМЕТКИ ===
app.get('/api/notes/:userId', (req, res) => {
    db.all("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC", [req.params.userId], (err, notes) => {
        res.json({ notes: notes || [] });
    });
});

app.post('/api/create-note', (req, res) => {
    const { userId, title, content } = req.body;
    const noteId = generateId();
    db.run("INSERT INTO notes (id, user_id, title, content) VALUES (?, ?, ?, ?)", [noteId, userId, title, content]);
    res.json({ success: true });
});

app.post('/api/delete-note', (req, res) => {
    const { noteId } = req.body;
    db.run("DELETE FROM notes WHERE id = ?", [noteId]);
    res.json({ success: true });
});

// === ОБНОВЛЕНИЕ ПОБЕД (опционально) ===
app.post('/api/update-wins', (req, res) => {
    const { userId, wins } = req.body;
    db.run("UPDATE users SET wins = ? WHERE id = ?", [wins, userId]);
    res.json({ success: true });
});

// ========== WEBSOCKET ==========
const onlineUsers = new Map();

io.on('connection', (socket) => {
    let currentUserId = null;
    let currentUserName = null;
    
    socket.on('login', (data) => {
        currentUserId = data.userId;
        currentUserName = data.username;
        onlineUsers.set(data.userId, { socketId: socket.id, name: data.username, avatar: data.avatar, wins: data.wins || 0 });
        
        const list = [];
        for (let [id, user] of onlineUsers) {
            list.push({ id, name: user.name, avatar: user.avatar, wins: user.wins, online: true });
        }
        io.emit('users-list', list);
    });
    
    // ЛИЧНОЕ СООБЩЕНИЕ (текст, файл, голосовое)
    socket.on('message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO messages (id, from_id, to_id, text, file, file_type, voice, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
            [messageId, currentUserId, data.to, data.text || null, data.file || null, data.fileType || null, data.voice || null, time]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('new-message', {
                id: messageId,
                from: currentUserId,
                fromName: currentUserName,
                text: data.text,
                file: data.file,
                fileType: data.fileType,
                voice: data.voice,
                time: time
            });
        }
        // Отправляем обратно отправителю для отображения
        socket.emit('new-message', {
            id: messageId,
            from: currentUserId,
            fromName: currentUserName,
            text: data.text,
            file: data.file,
            fileType: data.fileType,
            voice: data.voice,
            time: time
        });
    });
    
    // ГРУППОВОЕ СООБЩЕНИЕ
    socket.on('group-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO group_messages (id, group_id, from_id, text, time) VALUES (?, ?, ?, ?, ?)", 
            [messageId, data.groupId, currentUserId, data.text, time]);
        
        db.all("SELECT user_id FROM group_members WHERE group_id = ?", [data.groupId], (err, members) => {
            members.forEach(member => {
                const memberSocket = onlineUsers.get(member.user_id);
                if (memberSocket) {
                    io.to(memberSocket.socketId).emit('new-group-message', {
                        id: messageId,
                        groupId: data.groupId,
                        from: currentUserId,
                        fromName: currentUserName,
                        text: data.text,
                        time: time
                    });
                }
            });
        });
    });
    
    socket.on('group-join-notify', (data) => {
        db.all("SELECT user_id FROM group_members WHERE group_id = ?", [data.groupId], (err, members) => {
            members.forEach(member => {
                const memberSocket = onlineUsers.get(member.user_id);
                if (memberSocket && member.user_id !== currentUserId) {
                    io.to(memberSocket.socketId).emit('system-message', {
                        groupId: data.groupId,
                        text: `👤 ${data.userName} присоединился к группе`
                    });
                }
            });
        });
    });
    
    // Печатает
    socket.on('typing', (data) => {
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('typing', { from: currentUserName });
        }
    });
    
    // Звонки (заглушка, но сигналы проходят)
    socket.on('call-user', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('incoming-call', {
                fromId: currentUserId,
                fromName: currentUserName,
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
    
    socket.on('disconnect', () => {
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            db.run("UPDATE users SET online = 0 WHERE id = ?", [currentUserId]);
            const list = [];
            for (let [id, user] of onlineUsers) {
                list.push({ id, name: user.name, avatar: user.avatar, wins: user.wins, online: true });
            }
            io.emit('users-list', list);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на ${PORT}`));
