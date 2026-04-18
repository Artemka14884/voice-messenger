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
if (!fs.existsSync('./public')) fs.mkdirSync('./public');
if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });
if (!fs.existsSync('./public/avatars')) fs.mkdirSync('./public/avatars', { recursive: true });
if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') cb(null, './public/avatars');
        else if (file.fieldname === 'voice') cb(null, './public/voice');
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
        wins INTEGER DEFAULT 0,
        online INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        file TEXT,
        voice TEXT,
        time TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Группы
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
    
    // Заметки
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
    
    // Владелец
    db.get("SELECT * FROM users WHERE username = 'Artemka1488'", async (err, user) => {
        if (!user) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO users (id, username, password) VALUES ('owner1', 'Artemka1488', ?)", [hash]);
            console.log('✅ Artemka1488 / admin123');
        }
    });
    
    // Демо группа
    db.get("SELECT * FROM groups WHERE name = 'Общий чат'", (err, group) => {
        if (!group) {
            db.run("INSERT INTO groups (id, name) VALUES ('group1', 'Общий чат')");
        }
    });
    
    db.get("SELECT * FROM invite_codes WHERE code = 'FRIEND2024'", (err, code) => {
        if (!code) db.run("INSERT INTO invite_codes (code, uses_left) VALUES ('FRIEND2024', 10000)");
    });
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// ========== API ==========

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

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    const avatarUrl = '/avatars/' + req.file.filename;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, userId]);
    res.json({ success: true, avatar: avatarUrl });
});

app.post('/api/upload-file', upload.single('file'), (req, res) => {
    const fileUrl = '/uploads/' + req.file.filename;
    const isImage = req.file.mimetype.startsWith('image/');
    res.json({ success: true, url: fileUrl, name: req.file.originalname, isImage });
});

app.post('/api/voice', upload.single('voice'), (req, res) => {
    const voiceUrl = '/voice/' + req.file.filename;
    res.json({ success: true, url: voiceUrl });
});

app.get('/api/users/:userId', (req, res) => {
    db.all("SELECT id, username, online, avatar, wins FROM users WHERE id != ?", [req.params.userId], (err, users) => {
        res.json({ users: users || [] });
    });
});

app.get('/api/messages/:userId/:friendId', (req, res) => {
    db.all(`SELECT * FROM messages 
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at ASC LIMIT 200`, 
        [req.params.userId, req.params.friendId, req.params.friendId, req.params.userId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Группы
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

// Заметки
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

app.post('/api/update-wins', (req, res) => {
    const { userId, wins } = req.body;
    db.run("UPDATE users SET wins = ? WHERE id = ?", [wins, userId]);
    res.json({ success: true });
});

app.post('/api/add-friend', (req, res) => {
    const { userId, friendUsername } = req.body;
    db.get("SELECT id FROM users WHERE username = ?", [friendUsername], (err, friend) => {
        if (!friend) return res.json({ error: 'Пользователь не найден' });
        res.json({ success: true });
    });
});

// ========== WEBSOCKET ==========
const onlineUsers = new Map();
let gameRooms = new Map();

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
        
        db.run("INSERT INTO messages (id, from_id, to_id, text, file, voice, time) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [messageId, currentUserId, data.to, data.text || null, data.file || null, data.voice || null, time]);
        
        const toUser = onlineUsers.get(data.to);
        if (toUser) {
            io.to(toUser.socketId).emit('new-message', {
                id: messageId,
                from: currentUserId,
                text: data.text,
                file: data.file,
                voice: data.voice,
                time: time
            });
        }
    });
    
    // Групповое сообщение
    socket.on('group-message', (data) => {
        const messageId = generateId();
        const time = new Date().toLocaleTimeString();
        
        db.run("INSERT INTO group_messages (id, group_id, from_id, text, time) VALUES (?, ?, ?, ?, ?)", 
            [messageId, data.groupId, currentUserId, data.text, time]);
        
        db.all("SELECT user_id FROM group_members WHERE group_id = ?", [data.groupId], (err, members) => {
            members.forEach(member => {
                const memberSocket = onlineUsers.get(member.user_id);
                if (memberSocket && member.user_id !== currentUserId) {
                    io.to(memberSocket.socketId).emit('new-group-message', {
                        id: messageId,
                        groupId: data.groupId,
                        from: currentUserId,
                        fromName: data.fromName,
                        text: data.text,
                        time: time
                    });
                }
            });
        });
    });
    
    // Уведомление о входе в группу
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
            io.to(toUser.socketId).emit('typing', { from: data.name });
        }
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
    
    // ИГРА
    socket.on('invite-game', (data) => {
        const toUser = onlineUsers.get(data.toUserId);
        if (toUser) {
            io.to(toUser.socketId).emit('game-invite', {
                fromId: currentUserId,
                fromName: data.fromName
            });
        } else {
            socket.emit('game-error', { message: 'Пользователь не в сети' });
        }
    });
    
    socket.on('accept-game', (data) => {
        const fromUser = onlineUsers.get(data.fromId);
        if (fromUser) {
            const roomId = `game_${data.fromId}_${currentUserId}`;
            gameRooms.set(roomId, {
                players: [data.fromId, currentUserId],
                scores: { [data.fromId]: 0, [currentUserId]: 0 },
                ball: { x: 400, y: 250, vx: 3, vy: 2 },
                paddles: { [data.fromId]: 200, [currentUserId]: 200 }
            });
            
            io.to(fromUser.socketId).emit('game-start', { roomId, opponent: currentUserId });
            io.to(toUser.socketId).emit('game-start', { roomId, opponent: data.fromId });
        }
    });
    
    socket.on('game-decline', (data) => {
        const toUser = onlineUsers.get(data.toId);
        if (toUser) {
            io.to(toUser.socketId).emit('game-declined');
        }
    });
    
    socket.on('game-move', (data) => {
        const room = gameRooms.get(data.roomId);
        if (room) {
            room.paddles[data.playerId] = data.y;
            
            const ball = room.ball;
            const paddleLeft = room.paddles[room.players[0]];
            const paddleRight = room.paddles[room.players[1]];
            
            ball.x += ball.vx;
            ball.y += ball.vy;
            
            if (ball.y <= 0 || ball.y >= 500) ball.vy = -ball.vy;
            
            if (ball.x <= 20 && ball.x >= 15 && ball.y >= paddleLeft && ball.y <= paddleLeft + 100) {
                ball.vx = -ball.vx;
            }
            if (ball.x >= 780 && ball.x <= 785 && ball.y >= paddleRight && ball.y <= paddleRight + 100) {
                ball.vx = -ball.vx;
            }
            
            if (ball.x <= 0) {
                room.scores[room.players[1]]++;
                ball.x = 400; ball.y = 250;
                ball.vx = 3;
                ball.vy = 2;
            }
            if (ball.x >= 800) {
                room.scores[room.players[0]]++;
                ball.x = 400; ball.y = 250;
                ball.vx = -3;
                ball.vy = 2;
            }
            
            const state = {
                ball: { x: ball.x, y: ball.y },
                paddles: room.paddles,
                scores: room.scores
            };
            
            io.to(room.players[0]).to(room.players[1]).emit('game-state', state);
        }
    });
    
    socket.on('game-end', (data) => {
        const room = gameRooms.get(data.roomId);
        if (room) {
            const winner = room.scores[room.players[0]] > room.scores[room.players[1]] ? room.players[0] : room.players[1];
            db.get("SELECT wins FROM users WHERE id = ?", [winner], (err, user) => {
                const newWins = (user.wins || 0) + 1;
                db.run("UPDATE users SET wins = ? WHERE id = ?", [newWins, winner]);
                io.to(room.players[0]).to(room.players[1]).emit('game-over', { winner, newWins });
            });
            gameRooms.delete(data.roomId);
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
