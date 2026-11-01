const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let systemStatus = {}; 
let clients = [];

function broadcast() {
    const payload = `data: ${JSON.stringify(systemStatus)}\n\n`;
    clients.forEach(client => client.write(payload));
}

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
    
    // Calculate if ANY room is currently triggered
    let isGlobalAlarm = false;
    for (let mod in systemStatus) {
        if (systemStatus[mod].alarmTriggered) {
            isGlobalAlarm = true;
            break;
        }
    }
    
    broadcast();
    
    // Respond with the JSON payload so the Wemos knows to turn on the siren
    res.status(200).json({ globalAlarm: isGlobalAlarm });
});

app.post('/api/reset-all', (req, res) => {
    for (let mod in systemStatus) {
        systemStatus[mod].alarmTriggered = false;
        systemStatus[mod].rfCode = null;
    }
    broadcast();
    res.sendStatus(200);
});

// Checks for offline nodes every 3 seconds
setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (let mod in systemStatus) {
        // 25 second timeout for fast UI updates
        if (systemStatus[mod].status === 'online' && (now - systemStatus[mod].lastSeen > 25000)) {
            systemStatus[mod].status = "offline";
            changed = true;
        }
    }
    if (changed) broadcast();
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alarm server running on port ${PORT}`));
