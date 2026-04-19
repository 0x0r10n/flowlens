import Client from '@triton-one/yellowstone-grpc';
console.log('Client keys:', Object.keys(Client || {}));
console.log('Client type:', typeof Client);
console.log('Is function:', typeof Client === 'function');
console.log('Prototype:', Client.prototype ? Object.getOwnPropertyNames(Client.prototype) : 'none');

// Try constructing
try {
    const c = new Client('http://test', 'token', {});
    console.log('Constructor succeeded:', typeof c);
} catch (e) {
    console.log('Constructor error:', e.message);
}
