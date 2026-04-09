cat > server.js << 'EOF'
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

if (!fs.existsSync('./public/voice')) fs.mkdirSync('./public/voice', { recursive: true });

const users = new Map();
const messages = new Map();
const onlineUsers = new Map();

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 2) return res.json({ error: 'Ник от 2 символов' });
    for (let [_, user] of users) {
        if (user.username === username) return res.json({ error: 'Ник занят' });
    }
    const userId = generateId();
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
    const roomId = [req.params.userId, req.params.otherId].sort().join('_');
    const msgs = messages.get(roomId) || [];
    res.json({ messages: msgs });
});

app.post('/api/voice-message', (req, res) => {
    const { audioData, fromId, toId } = req.body;
    const filename = `${Date.now()}_${fromId}.webm`;
    const filepath = `/voice/${filename}`;
    const buffer = Buffer.from(audioData.split(',')[1], 'base64');
    fs.writeFileSync(`./public${filepath}`, buffer);
    res.json({ success: true, url: filepath });
});

io.on('connection', (socket) => {
    let currentUserId = null;
    
    socket.on('user-online', (data) => {
        currentUserId = data.userId;
        onlineUsers.set(data.userId, socket.id);
        broadcastUsers();
    });
    
    socket.on('private-message', (data) => {
        const roomId = [currentUserId, data.toUserId].sort().join('_');
        if (!messages.has(roomId)) messages.set(roomId, []);
        
        const message = {
            id: generateId(),
            fromId: currentUserId,
            toId: data.toUserId,
            text: data.text || null,
            voice: data.voice || null,
            replyTo: data.replyTo || null,
            reactions: {},
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            read: false,
            delivered: false
        };
        
        messages.get(roomId).push(message);
        
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('new-message', message);
            message.delivered = true;
        }
        socket.emit('message-sent', message);
        broadcastUsers();
    });
    
    // Реакция на сообщение
    socket.on('add-reaction', (data) => {
        const { messageId, reaction, toUserId } = data;
        const roomId = [currentUserId, toUserId].sort().join('_');
        const msgs = messages.get(roomId);
        if (msgs) {
            const msg = msgs.find(m => m.id === messageId);
            if (msg) {
                if (!msg.reactions) msg.reactions = {};
                msg.reactions[currentUserId] = reaction;
                
                const toSocket = onlineUsers.get(toUserId);
                if (toSocket) {
                    io.to(toSocket).emit('reaction-added', { messageId, reaction, fromId: currentUserId });
                }
                socket.emit('reaction-added', { messageId, reaction, fromId: currentUserId });
            }
        }
    });
    
    socket.on('mark-read', (data) => {
        const { messageId, fromUserId } = data;
        const roomId = [currentUserId, fromUserId].sort().join('_');
        const msgs = messages.get(roomId);
        if (msgs) {
            const msg = msgs.find(m => m.id === messageId);
            if (msg && !msg.read) {
                msg.read = true;
                msg.readAt = new Date().toLocaleTimeString();
                const fromSocket = onlineUsers.get(fromUserId);
                if (fromSocket) {
                    io.to(fromSocket).emit('message-read', { messageId, readAt: msg.readAt });
                }
            }
        }
    });
    
    socket.on('typing', (data) => {
        const toSocket = onlineUsers.get(data.toUserId);
        if (toSocket) {
            io.to(toSocket).emit('user-typing', { fromId: currentUserId, name: users.get(currentUserId)?.username });
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
        for (let [id, user] of users) {
            list.push({ id: user.id, username: user.username, online: onlineUsers.has(id) });
        }
        io.emit('users-list', list);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));
EOF