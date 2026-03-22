const fs = require('fs');

let code = fs.readFileSync('src/createMirage.ts', 'utf8');

code = code.replace(
    /return new Proxy\(typeof stateTarget === 'object' && stateTarget !== null \? stateTarget : \(\) => \{\}, \{/,
    'return new Proxy(function() { return stateTarget; }, {'
);

fs.writeFileSync('src/createMirage.ts', code);
console.log('done fixing proxy init');
