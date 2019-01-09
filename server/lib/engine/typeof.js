/******************************************************************************
 *    Copyright 2018 The LuaCoderAssist Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 ********************************************************************************/
'use strict';

const _ = require('underscore');
const { LuaBasicTypes, LazyValue, LuaSymbolKind, LuaSymbol, LuaTable } = require('./symbol');
const { StackNode } = require('./linear-stack');
const { LoadedPackages, namedTypes, _G } = require('./luaenv');
const Is = require('./is');
const utils_1 = require('./utils');

/**
 * Deduce the type of the symbol
 * @param {LuaSymbol} symbol the symbol
 */
function typeOf(symbol) {
    if (!symbol) {
        return LuaBasicTypes.any;
    }

    let type = symbol.type;
    let isLazy = Is.lazyValue(type);
    try {
        type = deduceType(type);
    } catch (err) {
        type = LuaBasicTypes.any;
    }

    if (isLazy) {
        if (Is.luaModule(type)) {
            symbol.kind = LuaSymbolKind.module;
        } else if (Is.luaTable(type)) {
            symbol.kind = LuaSymbolKind.class;
        } else if (Is.luaFunction(type)) {
            symbol.kind = LuaSymbolKind.function;
        }
    }

    if (symbol.kind === LuaSymbolKind.parameter && Is.luaAny(type)) {
        return type;
    }

    if (type !== LuaBasicTypes.any) {
        symbol.type = type
    };

    return type;
}

function deduceType(type) {
    if (!Is.lazyValue(type)) {
        return type;
    }

    let typeSymbol = parseAstNode(type.node, type);
    return deduceType(typeSymbol) || LuaBasicTypes.any;
}

function parseAstNode(node, type) {
    if (!node || node.isParsed) return null;
    let varType;
    node.isParsed = true; /*防止循环推导*/
    switch (node.type) {
        case 'ref':
            varType = parseRefNode(node);
            break;
        case 'StringLiteral':
            varType = LuaBasicTypes.string;
            break;
        case 'NumericLiteral':
            varType = LuaBasicTypes.number;
            break;
        case 'BooleanLiteral':
            varType = LuaBasicTypes.boolean;
            break;
        case 'NilLiteral':
            varType = LuaBasicTypes.any;
            break;
        case 'Identifier':
            varType = parseIdentifier(node, type);
            break;
        case 'UnaryExpression':
            varType = parseUnaryExpression(node, type);
            break;
        case 'BinaryExpression':
            varType = parseBinaryExpression(node, type);
            break;
        case 'MemberExpression':
            varType = parseMemberExpression(node, type);
            break;
        case 'StringCallExpression':
        case 'CallExpression':
            varType = parseCallExpression(node, type);
            break;
        case 'LogicalExpression':
            varType = parseLogicalExpression(node, type);
            break;
        case 'TableConstructorExpression':
            varType = parseTableConstructorExpression(node, type);
            break;
        case 'VarargLiteral':
            varType = parseVarargLiteral(node, type);
            break;
        case 'MergeType':
            varType = mergeType(node.left, node.right);
            break;
        case 'setmetatable':
            varType = setmetatable(node, type);
            break;
        default:
            varType = null;
    }
    node.isParsed = false;
    return varType;
}

function setmetatable(node, type) {
    let baseType = deduceType(node.base.type);
    if (baseType && Is.luaTable(baseType)) {
        let metaType = deduceType(node.meta.type);
        baseType.setmetatable(metaType);
        return baseType;
    }

    return undefined;
}

function parseRefNode(node) {
    const refSymbol = namedTypes.get(node.name);
    return refSymbol && refSymbol.type;
}

function mergeType(left, right) {
    let leftType = deduceType(left);
    let rightType = deduceType(right);

    return typeScore(leftType) > typeScore(rightType) ? leftType : rightType;
}

function typeScore(t) {
    if (Is.luaAny(t)) {
        return 0;
    } else if (Is.luaBoolean(t) || Is.luaNumber(t) || Is.luaString(t)) {
        return 1;
    } else if (Is.luaFunction(t)) {
        return 2;
    } else if (Is.luaTable(t)) {
        return 3;
    } else if (Is.luaModule(t)) {
        return 4;
    } else {
        return 0;
    }
}

function parseLogicalExpression(node, type) {
    const context = type.context;
    const name = type.name;
    if (node.operator === 'and') {
        return parseAstNode(node.right, type);
    } else if (node.operator === 'or') {
        return parseAstNode({
            type: 'MergeType',
            left: new LazyValue(context, node.left, name, 0),
            right: new LazyValue(context, node.right, name, 0)
        }, type);
    } else {
        return null;
    }
}

function parseCallExpression(node, type) {
    let ftype = parseMemberExpression(node.base, type);
    if (!Is.luaFunction(ftype)) {
        return null;
    }

    const fname = node.base.name;
    if (fname === 'require') {
        let modulePath = (node.argument || node.arguments[0]).value;
        let moduleName = modulePath.match(/\w+(-\w+)*$/)[0];
        let shortPath = modulePath.replace(/\./g, '/');
        let mdls = LoadedPackages[moduleName];
        // TODO：增加配置项，用来配置搜索路径，然后模拟lua的搜索方法搜索最优匹配模块
        for (const uri in mdls) {
            if (uri.includes(shortPath)) { // 查找最优匹配，如果存在多个最优匹配，则返回第一个
                const ret = mdls[uri].type.return;
                return ret && ret.type;
            }
        }

        let symbol = _G.get(moduleName);
        return symbol && symbol.type;
    }

    if (fname === 'setmetatable') {
        return parseSetMetatable(node, type);
    }

    let R = ftype.returns[type.index || 0];
    if (R === undefined) {
        return unwrapTailCall(ftype, type);
    }

    if (!Is.lazyValue(R.type)) {
        if (Is.luaTable(R.type) && (R.isLocal)) {
            return inheritFrom(R);
        }
        return R.type;
    }

    // 推导调用参数类型，用来支持推导返回值类型
    const func_argt = node.arguments.map((arg, index) => {
        let argType;
        if (node.isParsed) { // 防止循环推导
            node.isParsed = false;
            argType = LuaBasicTypes.any;
        } else {
            node.isParsed = true;
            argType = parseAstNode(arg, type);
        }
        return { name: ftype.args[index].name, type: argType };
    });

    let rt = parseForStdlibFunction(node.base.name, func_argt, type);
    if (rt) {
        return rt;
    }

    if (R.type.context) {
        R.type.context.func_argt = func_argt; // dynamic add
    }
    let retType = deduceType(R.type); //deduce the type
    if (R.type.context) {
        R.type.context.func_argt = undefined; // remove
    }

    if (Is.luaTable(retType) && (R.isLocal)) {
        return inheritFrom(R);
    }

    return retType;
}

function unwrapTailCall(ftype, stype) {
    if (!ftype.tailCall) {
        return LuaBasicTypes.any;
    }
    let tailType = ftype.tailCall;
    tailType.index = stype.index - ftype.returns.length + 1;
    return deduceType(tailType);
}
/**
 * Create a new LuaTable inherit from tableSymbol
 * @param {LuaSymbol} tableSymbol the parent table symbol
 * @returns {LuaTable}
 */
function inheritFrom(tableSymbol) {
    let metaTable = new LuaSymbol('__metatable', tableSymbol.location,
        tableSymbol.range, tableSymbol.scope, true, tableSymbol.uri, LuaSymbolKind.table,
        new LuaTable());
    metaTable.state = tableSymbol.state;
    metaTable.set('__index', tableSymbol);
    return new LuaTable(metaTable);
}

function parseSetMetatable(node, type) {
    if (!type || !type.context || !type.context.func_argt) {
        return undefined;
    }

    const baseNode = node.arguments[0];
    if (!baseNode) {
        return undefined;
    }

    const baseTable = deduceType(new LazyValue(type.context, baseNode, type.name, 0));
    if (!Is.luaTable(baseTable)) {
        return undefined;
    }

    const metaNode = node.arguments[1];
    if (!metaNode) {
        return baseTable;
    }

    const metaTable = deduceType(new LazyValue(type.context, metaNode, "__mt", 0));
    if (Is.luaTable(metaTable)) {
        baseTable.setmetatable(metaTable);
    }

    return baseTable;
}

function parseForStdlibFunction(funcName, argsType, type) {
    switch (funcName) {
        case 'setmetatable':
            let table = argsType[0].type;
            if (Is.luaTable(table)) {
                let mt = new LuaSymbol('__mt', null, null, null, true, type.context.module.uri, LuaSymbolKind.table, argsType[1].type);
                table.setmetatable(mt);
            }
            return table;
        case 'require':
        default:
            break;
    }
}

function parseMemberExpression(node, type) {
    let names = utils_1.baseNames(node);
    let name = names[0];
    let symbol = type.context.search(name, node.range, d => d.name === name);
    if (!symbol) {
        return null;
    }

    let def = symbol;
    for (let i = 1, size = names.length; i < size; ++i) {
        let t = typeOf(def);
        if (Is.luaFunction(t) && t.returns) {
            def = t.returns[0];
            t = typeOf(def);
        }
        if (!def || !(Is.luaTable(t) || Is.luaModule(t))) {
            return null;
        }
        const name = names[i];
        def = t.search(name, node.base.range).value;
    }

    return typeOf(def);
}

function parseUnaryExpression(node) {
    switch (node.operator) {
        case '#':
        case '-': // -123
            return LuaBasicTypes.number;
        case 'not': // not x
            return LuaBasicTypes.boolean;
        default:
            return null;
    }
}

function parseBinaryExpression(node, type) {
    // 暂时不支持运算符重载
    switch (node.operator) {
        case '..':
            return LuaBasicTypes.string;
        case '==':
        case '~=':
        case '>':
        case '<':
        case '>=':
        case '<=':
            return LuaBasicTypes.boolean;
        case '+':
        case '-':
        case '*':
        case '^':
        case '/':
        case '%':
            return LuaBasicTypes.number;
        default:
            return null;
    }
}

function parseTableConstructorExpression(node, type) {
    let table = new LuaTable();
    node.fields.forEach(field => {
        if (field.type !== 'TableKeyString') {
            return;
        }

        let name = field.key.name;
        let ft = parseAstNode(field.value, type);
        let fs = new LuaSymbol(name, field.key.range, field.key.range, node.range, true, type.context.module.uri, LuaSymbolKind.property, ft);
        table.set(name, fs);
    });
    return table;
}

function parseIdentifier(node, type) {
    let func_argt = type.context.func_argt;
    let identType;
    func_argt && func_argt.forEach(argt => {
        if (argt.name === node.name) {
            identType = argt.type;
        }
    });
    if (identType && !Is.luaAny(identType)) {
        return identType;
    }

    let symbol = type.context.search(node.name, node.range);
    return symbol && typeOf(symbol);
}

function parseVarargLiteral(node, type) {
    return parseIdentifier({ name: node.value }, type);
}

/**
 * Search the most inner scope of range
 * @param {LinearStack} stack root scope to begin search
 * @param {Number[]} location [start, end]
 */
function searchInnerStackIndex(stack, location) {
    let refNode = new StackNode({ location });
    return _.sortedIndex(stack.nodes, refNode, (node) => {
        return node.data.location[0] - location[0];
    });
}

/**
 * Find the definition of symbol with name in document(uri)
 * @param {String} name symbol name 
 * @param {String} uri uri of the document
 * @param {Array<Number>} range range of the reference
 * @return {LuaSymbol} The symbol
 */
function findDef(name, uri, range) {
    let theModule = LoadedPackages[uri]
    if (!theModule) {
        return null;
    }
    return theModule.type.search(name, range, (data) => {
        return data.name === name
    }).value;
}


module.exports = {
    typeOf,
    findDef,
    deduceType,
    searchInnerStackIndex
}