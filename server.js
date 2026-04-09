const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

const users = new Map();
const messages = [];
const onlineUsers = new Map();

app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 2) {
        return res.json({ error: 'Ник от 2 символов' });
    }
    for (let [_, user] of users) {
        if (user.username === username) {
            return res.json({ error: 'Ник занят' });
        }
    }
    const userId = Date.now().toString();
    users.set(userId, { id: userId, username });
    res.json({ success: true, userId, username });
});

app.get('/api/users', (req, res) => {
    const list = [];
    for (let [id, user] of users) {
        list.push({ id: user.id, username: user.username, online: onlineUsers.has(id) });
    }
    res.json({ users: list });
});

app.get('/api/messages/:userId/:otherId', (req, res) => {
    const userMessages = messages.filter(m => 
        (m.fromId === req.params.userId && m.toId === req.params.otherId) ||
        (m.fromId === req.params.otherId && m.toId === req.params.userId)
    );
    res.json({ messages: userMessages.slice(-50) });
});

io.on('connection', (socket) => {
    let currentUserId = null;
    
    socket.on('user-online', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, socket.id);
        const list = [];
        for (let [id, user] of users) {
            list.push({ id: user.id, username: user.username, online: onlineUsers.has(id) });
        }
        io.emit('users-list', list);
    });
    
    socket.on('private-message', (data) => {
        const msg = {
            id: Date.now(),
            fromId: currentUserId,
            toId: data.toUserId,
            text: data.text,
            time: new Date().toLocaleTimeString()
        };
        messages.push(msg);
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('new-message', msg);
        }
        socket.emit('message-sent', msg);
    });
    
    socket.on('disconnect', () => {
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            const list = [];
            for (let [id, user] of users) {
                list.push({ id: user.id, username: user.username, online: onlineUsers.has(id) });
            }
            io.emit('users-list', list);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
