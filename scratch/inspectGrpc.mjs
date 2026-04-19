import('@triton-one/yellowstone-grpc').then(m => {
    console.log('keys:', Object.keys(m));
    console.log('default type:', typeof m.default);
    console.log('default keys:', m.default ? Object.keys(m.default) : 'N/A');
    if (m.default && m.default.prototype) {
        console.log('default prototype:', Object.getOwnPropertyNames(m.default.prototype));
    }
    console.log('CommitmentLevel:', m.CommitmentLevel);
}).catch(e => console.error(e));
