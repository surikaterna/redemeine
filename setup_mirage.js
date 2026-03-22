const fs = require('fs');

let code = fs.readFileSync('src/createMirage.ts', 'utf8');

code = code.replace(
    /id: string,\r?\n\s*initialState\?: S,\r?\n\s*options\?: MirageOptions/,
    "id: string,\n    setup?: MirageOptions & { snapshot?: S; events?: Event[] }"
);

code = code.replace(
    /const core = new MirageCore\(builder, id, initialState \|\| builder\.initialState, options\?\.contract, options\?\.strict\);/,
    "const state = setup?.events?.reduce((acc, ev) => builder.apply(acc, ev), setup?.snapshot ?? builder.initialState) ?? (setup?.snapshot ?? builder.initialState);\n    const core = new MirageCore(builder, id, state, setup?.contract, setup?.strict);"
);

fs.writeFileSync('src/createMirage.ts', code);
console.log('done modifying createMirage');
