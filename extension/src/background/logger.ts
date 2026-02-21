// Quick polyfill to intercept console.error/log and write to storage so we can read it
const originalError = console.error;
const originalLog = console.log;

console.error = (...args) => {
    originalError(...args);
    chrome.storage.local.get({ errorLog: [] }, (data) => {
        const logs = data.errorLog;
        logs.push({ type: 'error', time: Date.now(), msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
        chrome.storage.local.set({ errorLog: logs.slice(-50) });
    });
};

console.log = (...args) => {
    originalLog(...args);
    chrome.storage.local.get({ errorLog: [] }, (data) => {
        const logs = data.errorLog;
        logs.push({ type: 'log', time: Date.now(), msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
        chrome.storage.local.set({ errorLog: logs.slice(-50) });
    });
};
