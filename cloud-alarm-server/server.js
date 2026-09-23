const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

// Force the server to send index.html when someone visits the main link
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Memory bank to store node data
let systemStatus = {}; 
let clients = [];

// Broadcasts real-time updates to all connected browser dashboards
function broadcast() {
    const payload = `data: ${JSON.stringify(systemStatus)}\n\n`;
    clients.forEach(client => client.write(payload));
}

// --- 1. SSE STREAM (DASHBOARD REAL-TIME CONNECTION) ---
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

// --- 2. WEMOS INCOMING DATA HANDLER ---
app.post('/api/alarm', (req, res) => {
    const { moduleId, type, code } = req.body;
    
    // Register new node if it doesn't exist
    if (!systemStatus[moduleId]) {
        systemStatus[moduleId] = { status: "online", lastSeen: 0, alarmTriggered: false, rfCode: null };
    }
    
    // Update "last seen" time to prevent node from going offline
    systemStatus[moduleId].lastSeen = Date.now();
    systemStatus[moduleId].status = "online";
    
    // If a Wemos sends an alarm payload, flag it
    if (type === "alarm") {
        systemStatus[moduleId].alarmTriggered = true;
        systemStatus[moduleId].rfCode = code;
    }
    
    broadcast(); // Update dashboard

    // Check if ANY node in the entire building has an active alarm
    let globalAlarm = false;
    for (let mod in systemStatus) {
        if (systemStatus[mod].alarmTriggered) {
            globalAlarm = true;
            break;
        }
    }
    
    // Reply to the Wemos telling it if it needs to sound its local siren
    res.json({ globalAlarm: globalAlarm });
});

// --- 3. DASHBOARD "SILENCE ALL" BUTTON HANDLER ---
app.post('/api/reset-all', (req, res) => {
    for (let mod in systemStatus) {
        systemStatus[mod].alarmTriggered = false;
        systemStatus[mod].rfCode = null;
    }
    broadcast();
    res.sendStatus(200);
});

// --- 4. OFFLINE DETECTOR TIMEOUT ---
// Checks for offline nodes every 3 seconds
setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (let mod in systemStatus) {
        // If a node hasn't sent a heartbeat in 25 seconds, mark as offline
        if (systemStatus[mod].status === 'online' && (now - systemStatus[mod].lastSeen > 25000)) {
            systemStatus[mod].status = "offline";
            changed = true;
        }
    }
    if (changed) broadcast(); // Update dashboard if someone went offline
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alarm server running on port ${PORT}`));
