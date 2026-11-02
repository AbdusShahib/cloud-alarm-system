const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

const storage = multer.diskStorage({
    destination: './public/',
    filename: (req, file, cb) => { cb(null, 'firmware.bin'); }
});
const upload = multer({ storage: storage });

// --- PERSISTENT STORAGE SETUP ---
const DB_FILE = path.join(__dirname, 'devices.json');
let systemStatus = {};

// Load saved devices on boot so offline devices don't vanish on server restart
if (fs.existsSync(DB_FILE)) {
    try {
        systemStatus = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        // Mark all loaded devices as offline initially until they check in
        for (let id in systemStatus) {
            if (systemStatus[id].status === 'online') {
                systemStatus[id].status = 'offline';
            }
        }
    } catch (e) {
        console.error("Error reading devices.json:", e);
    }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(systemStatus, null, 2));
    } catch (e) {
        console.error("Error writing devices.json:", e);
    }
}

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
    req.on('close', () => { clients = clients.filter(c => c !== res); });
});

app.post('/api/alarm', (req, res) => {
    const { id, name, moduleId, type, code, version } = req.body;
    const deviceId = id || moduleId;
    const deviceName = name || moduleId;
    
    if (!systemStatus[deviceId]) {
        systemStatus[deviceId] = { name: deviceName, status: "online", lastSeen: 0, alarmTriggered: false, rfCode: null, version: 1, pendingUpdate: false };
    }
    
    systemStatus[deviceId].name = deviceName;
    systemStatus[deviceId].lastSeen = Date.now();
    systemStatus[deviceId].status = "online";
    if (version) systemStatus[deviceId].version = version;
    
    if (type === "alarm") {
        systemStatus[deviceId].alarmTriggered = true;
        systemStatus[deviceId].rfCode = code;
    }
    
    let isGlobalAlarm = false;
    for (let mod in systemStatus) {
        if (systemStatus[mod].alarmTriggered) { isGlobalAlarm = true; break; }
    }
    
    let shouldUpdate = systemStatus[deviceId].pendingUpdate;
    if (shouldUpdate) systemStatus[deviceId].pendingUpdate = false; 
    
    saveDatabase(); // Save state persistently
    broadcast();
    res.status(200).json({ globalAlarm: isGlobalAlarm, update: shouldUpdate });
});

app.post('/api/reset-all', (req, res) => {
    for (let mod in systemStatus) {
        systemStatus[mod].alarmTriggered = false;
        systemStatus[mod].rfCode = null;
    }
    saveDatabase();
    broadcast();
    res.sendStatus(200);
});

// Admin & Dashboard API Endpoints
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
    saveDatabase();
    res.sendStatus(200);
});

app.post('/api/admin/delete', (req, res) => {
    const { id } = req.body;
    if (systemStatus[id] && systemStatus[id].status === 'offline') {
        delete systemStatus[id];
        saveDatabase();
        broadcast();
        res.sendStatus(200);
    } else {
        res.status(400).send("Cannot delete an online device.");
    }
});

app.post('/api/rename', (req, res) => {
    const { id, newName } = req.body;
    if (systemStatus[id] && newName) {
        systemStatus[id].name = newName.trim();
        saveDatabase();
        broadcast();
        res.sendStatus(200);
    } else {
        res.status(400).send("Invalid device or name.");
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
    if (changed) {
        saveDatabase();
        broadcast();
    }
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alarm server running on port ${PORT}`));
