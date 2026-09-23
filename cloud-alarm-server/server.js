// ... existing code ...
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
    
    // NEW: Check if ANY node has an active alarm to tell the Wemos
    let globalAlarm = false;
    for (let mod in systemStatus) {
        if (systemStatus[mod].alarmTriggered) {
            globalAlarm = true;
            break;
        }
    }
    
    // Send global state back to the Wemos module
    res.json({ globalAlarm: globalAlarm });
});

app.post('/api/reset-all', (req, res) => {
// ... existing code ...
