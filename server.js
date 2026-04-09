const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));
app.use(express.json());

// Простая база данных в памяти (для Render)
const users = new Map();
const messages = [];
const onlineUsers = new Map();

// Генерация ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// API
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2 || username.length > 20) {
        return res.json({ error: 'Ник от 2 до 20 символов' });
    }
    
    // Проверка на существующего
    for (let [_, user] of users) {
        if (user.username === username) {
            return res.json({ error: 'Ник уже занят' });
        }
    }
    
    const userId = generateId();
    users.set(userId, { id: userId, username: username, avatar: '/default-avatar.png' });
    
    res.json({ success: true, userId: userId, username: username });
});

// Получить пользователей
app.get('/api/users', (req, res) => {
    const userList = [];
    for (let [_, user] of users) {
        userList.push({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            online: onlineUsers.has(user.id)
        });
    }
    res.json({ users: userList });
});

// Получить сообщения
app.get('/api/messages/:userId/:otherId', (req, res) => {
    const userMessages = messages.filter(m => 
        (m.fromId === req.params.userId && m.toId === req.params.otherId) ||
        (m.fromId === req.params.otherId && m.toId === req.params.userId)
    );
    res.json({ messages: userMessages.slice(-50) });
});

// Socket.io
io.on('connection', (socket) => {
    console.log('✅ Подключился:', socket.id);
    let currentUserId = null;
    
    socket.on('user-online', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, socket.id);
        
        // Отправляем список пользователей
        const userList = [];
        for (let [id, user] of users) {
            userList.push({
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                online: onlineUsers.has(id)
            });
        }
        io.emit('users-list', userList);
    });
    
    // Личное сообщение
    socket.on('private-message', (data) => {
        const message = {
            id: Date.now(),
            fromId: currentUserId,
            toId: data.toUserId,
            text: data.message,
            time: new Date().toLocaleTimeString()
        };
        messages.push(message);
        
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('new-message', message);
        }
        socket.emit('message-sent', message);
    });
    
    // ========== ВИДЕО ЗВОНКИ (с TURN сервером) ==========
    
    socket.on('call-user', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('incoming-call', {
                fromId: currentUserId,
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
    
    socket.on('typing', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('user-typing', { fromId: currentUserId });
        }
    });
    
    socket.on('disconnect', () => {
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            const userList = [];
            for (let [id, user] of users) {
                userList.push({
                    id: user.id,
                    username: user.username,
                    online: onlineUsers.has(id)
                });
            }
            io.emit('users-list', userList);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Сервер на Render запущен на порту ${PORT}`);
});