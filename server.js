const express = require('express');
const http = require('http');
const path = require('path');
const sql = require('mssql');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const users = {};

const dbConfig = {
    user: 'node',
    password: '123',
    server: 'localhost',
    port: 1433,
    database: 'master',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        trustedConnection: false,
    }
};

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

async function connectDB() {
    try {
        const pool = await sql.connect(dbConfig);
        const userlist = await pool.request().query('SELECT username FROM Users');
        const dbUsers = userlist.recordset;
        global.usernames = dbUsers.map(user => user.username);
        console.log("All usernames:", global.usernames);
    } catch (err) {
        console.error("DB connection failed:", err);
    }
}

connectDB();

app.get('/favicon.ico', (req, res) => res.status(204));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('username', sql.VarChar, username)
            .query('SELECT * FROM Users WHERE username = @username');

        if (result.recordset.length === 0) {
            await pool.request()
                .input('username', sql.VarChar, username)
                .input('password', sql.VarChar, hashedPassword)
                .query("INSERT INTO Users (username, password) VALUES (@username, @password)");
            res.json({ message: 'User registered successfully' });
        } else {
            res.json({ message: 'Username already exists.' });
        }
    } catch (err) {
        console.error('Database error:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('username', sql.VarChar, username)
            .query('SELECT * FROM Users WHERE username = @username');

        if (result.recordset.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        const user = result.recordset[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: "Invalid password" });
        }

        const token = jwt.sign({ username: user.username }, 'secret_key', { expiresIn: '1h' });
        res.status(200).json({ message: 'Login successful', token, username });
    } catch (err) {
        console.error('Database error', err.message);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

const verifyToken = (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) return next(new Error("Authentication error: No token provided."));

    jwt.verify(token, 'secret_key', (err, decoded) => {
        if (err) return next(new Error("Authentication error: Invalid or expired token."));
        socket.username = decoded.username;
        next();
    });
};

io.use(verifyToken).on('connection', async (socket) => {
    users[socket.username] = socket.id;
    console.log(`${socket.username} connected`);

    // Send current online users
    io.emit('user list', global.usernames);

    socket.on('load chat', async ({ withUser }) => {
        try {
            const pool = await sql.connect(dbConfig);
            const result = await pool.request()
                .input('user1', sql.VarChar, socket.username)
                .input('user2', sql.VarChar, withUser)
                .query(`
                    SELECT * FROM Message 
                    WHERE (sender = @user1 AND receiver = @user2) 
                    OR (sender = @user2 AND receiver = @user1)
                    ORDER BY sent_at ASC
                `);
            socket.emit('chat history', result.recordset);
        } catch (err) {
            console.error("Error loading chat:", err.message);
        }
    });

    socket.on('disconnect', () => {
        delete users[socket.username];
        io.emit('user list', Object.keys(users));
        console.log(`${socket.username} disconnected`);
    });

    socket.on('private_message', async ({ toUserID, message }) => {
        try {
            const pool = await sql.connect(dbConfig);
            await pool.request()
                .input('sender', sql.VarChar, socket.username)
                .input('receiver', sql.VarChar, toUserID)
                .input('message', sql.Text, message)
                .query("INSERT INTO Message (sender, receiver, message) VALUES (@sender, @receiver, @message)");

            const chatData = {
                from: socket.username,
                to: toUserID,
                message,
                timestamp: new Date().toISOString()
            };

            socket.emit('private_message', chatData); // to sender

            const toSocketId = users[toUserID];
            if (toSocketId) {
                io.to(toSocketId).emit('private_message', chatData); // to receiver
            }
        } catch (err) {
            console.error("Error saving message:", err.message);
        }
    });

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('username', sql.VarChar, socket.username)
            .query("SELECT * FROM Message WHERE sender = @username OR receiver = @username ORDER BY sent_at DESC");

        socket.emit('message_history', result.recordset);
    } catch (err) {
        console.error("Error fetching messages:", err.message);
    }
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));
