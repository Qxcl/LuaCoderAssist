'use strict';
const _ = require('underscore');
const fs = require('fs');
const engine = require('../server/lib/engine');

//tester
fs.readFile('./test/textures/test01.lua', (err, data) => {
    let uri = './textures/test01.lua';
    engine.parseDocument(data, uri);
    console.log(engine.typeOf(engine.definitionProvider(new engine.DefinitionContext('x.a.fd', [123, 125], uri))));
    const completionItems = engine.completionProvider(new engine.CompletionContext('x.a.', [185, 186], uri));
    console.log(completionItems);
    console.log(completionItems[0]);
});
