const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

// Force the server to send index.html when someone visits the main link
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dev', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dev.html'));
});

// Memory bank to store node data & isolated OTA firmware buffers
let systemStatus = {}; 
let clients = [];
const POOL_ALARM_MAC = 'E0:98:06:A8:6B:2D';

let cloudFirmware = {
    buffer: null,
    fileName: null,
    pendingDevices: new Set()
};

let poolFirmware = {
    buffer: null,
    fileName: null,
    pending: false
};

// Broadcasts real-time updates to all connected browser dashboards
function broadcast() {
    const statePayload = {
        nodes: systemStatus,
        ota: {
            cloudPending: Array.from(cloudFirmware.pendingDevices),
            cloudFileName: cloudFirmware.fileName,
            poolPending: poolFirmware.pending,
            poolFileName: poolFirmware.fileName
        }
    };
    const payload = `data: ${JSON.stringify(systemStatus)}\n\n`;
    const devPayload = `event: devstate\ndata: ${JSON.stringify(statePayload)}\n\n`;
    clients.forEach(client => {
        client.write(payload);
        client.write(devPayload);
    });
}

// --- 1. SSE STREAM (DASHBOARD REAL-TIME CONNECTION) ---
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    clients.push(res);
    res.write(`data: ${JSON.stringify(systemStatus)}\n\n`);
    res.write(`event: devstate\ndata: ${JSON.stringify({
        nodes: systemStatus,
        ota: {
            cloudPending: Array.from(cloudFirmware.pendingDevices),
            cloudFileName: cloudFirmware.fileName,
            poolPending: poolFirmware.pending,
            poolFileName: poolFirmware.fileName
        }
    })}\n\n`);
    
    req.on('close', () => {
        clients = clients.filter(c => c !== res);
    });
});

// --- 2. WEMOS INCOMING DATA HANDLER ---
app.post('/api/alarm', (req, res) => {
    const { id, name, moduleId, type, code, version, standalone } = req.body;
    const deviceId = (id || moduleId || '').trim();
    const upperId = deviceId.toUpperCase();
    const deviceName = name || moduleId;
    const isPoolAlarm = upperId === POOL_ALARM_MAC;
    
    // Register new node if it doesn't exist
    if (!systemStatus[deviceId]) {
        systemStatus[deviceId] = { 
            name: deviceName,
            status: "online", 
            lastSeen: 0, 
            alarmTriggered: false, 
            rfCode: null,
            version: version || 1,
            standalone: isPoolAlarm || Boolean(standalone)
        };
    }
    
    // Update device metadata and "last seen" time
    systemStatus[deviceId].name = deviceName;
    systemStatus[deviceId].lastSeen = Date.now();
    systemStatus[deviceId].status = "online";
    systemStatus[deviceId].ip = req.ip;
    if (version) systemStatus[deviceId].version = version;
    systemStatus[deviceId].standalone = isPoolAlarm;
    
    // Only standard building nodes (not the pool alarm) trigger the building-wide global alarm
    if (type === "alarm" && !isPoolAlarm) {
        systemStatus[deviceId].alarmTriggered = true;
        systemStatus[deviceId].rfCode = code;
    }
    
    broadcast(); // Update dashboard

    // Check if ANY standard node in the entire building has an active alarm
    let globalAlarm = false;
    for (let mod in systemStatus) {
        if (mod.toUpperCase() !== POOL_ALARM_MAC && systemStatus[mod].alarmTriggered) {
            globalAlarm = true;
            break;
        }
    }

    // Isolated OTA check: Pool Alarm NEVER receives combined Cloud Alarm OTA flags
    let shouldUpdate = false;
    if (isPoolAlarm) {
        shouldUpdate = Boolean(poolFirmware.pending && poolFirmware.buffer);
    } else {
        shouldUpdate = Boolean(cloudFirmware.buffer && cloudFirmware.pendingDevices.has(upperId));
    }
    
    // Reply to the Wemos telling it if it needs to sound its local siren or pull OTA
    res.json({ globalAlarm: globalAlarm, update: shouldUpdate });
});

// --- 2B. ISOLATED OTA UPLOAD & DOWNLOAD ENDPOINTS ---
app.post('/api/ota/cloud', (req, res) => {
    const { fileBase64, fileName, target } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'Missing firmware binary' });

    cloudFirmware.buffer = Buffer.from(fileBase64, 'base64');
    cloudFirmware.fileName = fileName || 'firmware.bin';
    cloudFirmware.pendingDevices.clear();

    if (target === 'ALL') {
        // Queue ONLY standard Cloud Alarm nodes; strictly exclude Pool Alarm MAC
        for (let mod in systemStatus) {
            if (mod.toUpperCase() !== POOL_ALARM_MAC) {
                cloudFirmware.pendingDevices.add(mod.toUpperCase());
            }
        }
    } else if (target && target.toUpperCase() !== POOL_ALARM_MAC) {
        cloudFirmware.pendingDevices.add(target.toUpperCase());
    }

    broadcast();
    res.json({ ok: true, queued: Array.from(cloudFirmware.pendingDevices) });
});

app.post('/api/ota/pool', (req, res) => {
    const { fileBase64, fileName } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'Missing pool firmware binary' });

    poolFirmware.buffer = Buffer.from(fileBase64, 'base64');
    poolFirmware.fileName = fileName || 'pool-firmware.bin';
    poolFirmware.pending = true;

    broadcast();
    res.json({ ok: true });
});

app.post('/api/ota/cancel', (req, res) => {
    const { scope } = req.body;
    if (scope === 'pool') {
        poolFirmware.pending = false;
    } else {
        cloudFirmware.pendingDevices.clear();
    }
    broadcast();
    res.json({ ok: true });
});

app.get('/firmware.bin', (req, res) => {
    const poolNode = Object.entries(systemStatus).find(([id]) => id.toUpperCase() === POOL_ALARM_MAC);
    const isPoolRequest = poolFirmware.pending && poolFirmware.buffer && (!poolNode || poolNode[1].ip === req.ip);

    if (isPoolRequest) {
        poolFirmware.pending = false;
        broadcast();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="pool-firmware.bin"');
        return res.send(poolFirmware.buffer);
    }

    if (!cloudFirmware.buffer) return res.status(404).send('No Cloud Alarm firmware uploaded');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="firmware.bin"');
    res.send(cloudFirmware.buffer);
});

app.get('/pool-firmware.bin', (req, res) => {
    if (!poolFirmware.buffer) return res.status(404).send('No Pool Alarm firmware uploaded');
    poolFirmware.pending = false; // Clear pending flag once Pool Alarm starts downloading
    broadcast();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="pool-firmware.bin"');
    res.send(poolFirmware.buffer);
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
