const socket = io('http://localhost:3000', {
    auth: { token: localStorage.getItem('token') }
});

socket.on('private message', ({ from, message }) => {
    console.log(`${from}: ${message}`);
});

function sendMessage() {
    const to = document.getElementById('recipient').value;
    const msg = document.getElementById('messageInput').value;
    socket.emit('private message', { to, message: msg });
}