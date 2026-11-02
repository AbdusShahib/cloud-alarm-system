const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

// Setup Multer to save uploaded firmware directly to the public folder
const storage = multer.diskStorage({
    destination: './public/',
    filename: (req, file, cb) => { cb(null, 'firmware.bin'); }
});
const upload = multer({ storage: storage });

let systemStatus = {}; 
let clients = [];

function broadcast() {
    const payload = `data: ${JSON.stringify(systemStatus)}\n\n`;
    clients.forEach(client => client.write(payload));
}

// Client Stream Endpoint
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

// Wemos Heartbeat & Alarm Endpoint
app.post('/api/alarm', (req, res) => {
    const { id, name, moduleId, type, code, version } = req.body;
    
    // Fallback for older firmware that only sends 'moduleId'
    const deviceId = id || moduleId;
    const deviceName = name || moduleId;
    
    if (!systemStatus[deviceId]) {
        systemStatus[deviceId] = { name: deviceName, status: "online", lastSeen: 0, alarmTriggered: false, rfCode: null, version: 1, pendingUpdate: false };
    }
    
    // Update active states
    systemStatus[deviceId].name = deviceName;
    systemStatus[deviceId].lastSeen = Date.now();
    systemStatus[deviceId].status = "online";
    if (version) systemStatus[deviceId].version = version;
    
    if (type === "alarm") {
        systemStatus[deviceId].alarmTriggered = true;
        systemStatus[deviceId].rfCode = code;
    }
    
    // Calculate global alarm state
    let isGlobalAlarm = false;
    for (let mod in systemStatus) {
        if (systemStatus[mod].alarmTriggered) {
            isGlobalAlarm = true;
            break;
        }
    }
    
    // Check if admin queued an update for this specific device
    let shouldUpdate = systemStatus[deviceId].pendingUpdate;
    if (shouldUpdate) {
        systemStatus[deviceId].pendingUpdate = false; // Reset flag
    }
    
    broadcast();
    res.status(200).json({ globalAlarm: isGlobalAlarm, update: shouldUpdate });
});

// Reset All Alarms Endpoint
app.post('/api/reset-all', (req, res) => {
    for (let mod in systemStatus) {
        systemStatus[mod].alarmTriggered = false;
        systemStatus[mod].rfCode = null;
    }
    broadcast();
    res.sendStatus(200);
});

// --- ADMIN API ENDPOINTS ---
app.post('/api/admin/upload', upload.single('firmware'), (req, res) => {
    res.status(200).send("Firmware uploaded successfully.");
});

app.post('/api/admin/update', (req, res) => {
    const { moduleId } = req.body;
    if (moduleId === 'ALL') {
        for (let mod in systemStatus) systemStatus[mod].pendingUpdate = true;
    } else if (systemStatus[moduleId]) {
        systemStatus[moduleId].pendingUpdate = true;
    }
    res.sendStatus(200);
});

app.post('/api/admin/delete', (req, res) => {
    const { id } = req.body;
    if (systemStatus[id] && systemStatus[id].status === 'offline') {
        delete systemStatus[id];
        broadcast();
        res.sendStatus(200);
    } else {
        res.status(400).send("Cannot delete an online device.");
    }
});

// Checks for offline nodes every 3 seconds
setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (let mod in systemStatus) {
        if (systemStatus[mod].status === 'online' && (now - systemStatus[mod].lastSeen > 25000)) {
            systemStatus[mod].status = "offline";
            changed = true;
        }
    }
    if (changed) broadcast();
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alarm server running on port ${PORT}`));
