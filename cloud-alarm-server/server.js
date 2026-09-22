const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public')); 

// Initial register of nodes matching your setup rooms/positions
let systemStatus = {
    "PRC 13th": { status: "online", lastSeen: Date.now(), alarmTriggered: false, rfCode: null },
    "Fuji 4th Accounts": { status: "offline", lastSeen: 0, alarmTriggered: false, rfCode: null }
};

let clients = [];

function broadcast() {
    const payload = `data: ${JSON.stringify(systemStatus)}\n\n`;
    clients.forEach(client => client.write(payload));
}

// 1. SSE Real-Time Data Stream Endpoint
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    clients.push(res);
    res.write(`data: ${JSON.stringify(systemStatus)}\n\n`);
    
    req.on('close', () => {
        clients = clients.filter(c => c !== res);
    });
});

// 2. Endpoint for Wemos D1 modules to POST status/alarms
app.post('/api/alarm', (req, res) => {
    const { moduleId, type, code } = req.body;
    
    if (!systemStatus[moduleId]) {
        systemStatus[moduleId] = { status: "online", lastSeen: 0, alarmTriggered: false, rfCode: null };
    }
    
    systemStatus[moduleId].lastSeen = Date.now();
    systemStatus[moduleId].status = "online";
    
    if (type === "alarm") {
        systemStatus[moduleId].alarmTriggered = true;
        systemStatus[moduleId].rfCode = code;
    }
    
    broadcast();
    res.sendStatus(200);
});

// 3. Endpoint for Dashboard "Silence All Alarms" button
app.post('/api/reset-all', (req, res) => {
    for (let mod in systemStatus) {
        systemStatus[mod].alarmTriggered = false;
        systemStatus[mod].rfCode = null;
    }
    broadcast();
    res.sendStatus(200);
});

// Background tracker to flag nodes as offline if heartbeat stops (>90s)
setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (let mod in systemStatus) {
        if (systemStatus[mod].status === 'online' && (now - systemStatus[mod].lastSeen > 90000)) {
            systemStatus[mod].status = "offline";
            changed = true;
        }
    }
    if (changed) broadcast();
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alarm server running on port ${PORT}`));