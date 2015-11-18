#!/usr/bin/env node
var babel = require('babel');
var fs = require('fs');
var path = require('path');
var config = require('../package.json');

var config = {
    helpers     : [
        'create-class',
        'class-call-check',
        'interop-require-default' ,
        'interop-require-wildcard',
        'defaults',
        'interop-export-wildcard',
        'create-class',
        'class-call-check',
        'sliced-to-array',
        'get',
        'inherits'
    ],
    src         : path.resolve(__dirname,'../src'),
    out         : path.resolve(__dirname,'../out'),
    translator  : {
        name    : 'asx-translator',
        version : config.version
    },
    compiler    : {
        name    : 'asx-compiler',
        version : config.version,
        cjs     : ['path','fs']
    },
    runtime     : {
        name    : 'asx-runtime',
        version : config.version,
        files   : [
            'loader.js',
            'mirrors.js',
            'index.js'
        ]
    }
};


function makeDirRecursive(dir) {
    var parts = path.normalize(dir).split(path.sep);
    dir = '';
    for (var i = 0; i < parts.length; i++) {
        dir += parts[i] + path.sep;
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, 0x1FD);
        }
    }
}
function readDirRecursive(dir) {
    var items = fs.readdirSync(dir).map(function (s){
        return path.resolve(dir,s);
    });
    var files=[],dirs=[];
    items.forEach(function(f){
        if(fs.statSync(f).isDirectory()){
            dirs.push(f);
        }else{
            files.push(f);
        }
    });
    dirs.forEach(function(d){
        files = files.concat(readDirRecursive(d));
    });
    return files;
}
function resolveModuleId(parent,child){
    if(child[0]=='.'){
        return path.resolve(path.dirname('/'+parent),child).substring(1);
    }else{
        return child;
    }
}
function build_main(name){
    var helpers = [];
    var dependencies = {},dependants={};
    var cfg  = config[name];
    var src  = path.resolve(config.src,cfg.name);
    var out  = path.resolve(config.out,cfg.name,cfg.version);
    readDirRecursive(src).forEach(function(file){
        var outPath =  path.relative(src,file);
        var outFile =  path.resolve(out,outPath);
        var outId   =  path.resolve('/'+cfg.name,path.dirname(outPath),path.basename(outPath,'.js')).substring(1);
        var result = babel.transform(fs.readFileSync(file),{
            stage           : 0,
            blacklist       : ['strict'],
            externalHelpers : true
        });
        var modId = outId.split('/');
        modId.shift();
        modId = modId.join('/');
        var deps = dependencies[modId] = {imports:{},exports:{}};
        var imports = result.metadata.modules.imports;
        var exports = result.metadata.modules.exports;
        if(imports){
            imports.forEach(function(s){
                if(s.source){
                    var dep = resolveModuleId(outId,s.source);
                    var dpd = dep.split('/');
                    dpd.shift();
                    dpd = dpd.join('/');
                    dependants[dpd]=true;
                    deps.imports[dep]=true;
                }
            })
        }
        if(exports.specifiers){
            exports.specifiers.forEach(function(s){
                if(s.source){
                    var dep = resolveModuleId(outId,s.source);
                    var dpd = dep.split('/');
                    dpd.shift();
                    dpd = dpd.join('/');
                    dependants[dpd]=true;
                    deps.exports[dep]=true;
                }
            })
        }
        if(result.metadata.usedHelpers){
            result.metadata.usedHelpers.forEach(function(helper){
                if(helpers.indexOf(helper)<0){
                    helpers.push(helper);
                }
            })
        }
        makeDirRecursive(path.dirname(outFile));
        fs.writeFileSync(outFile,'Asx.module("'+outId+'",function cjs(__filename,__dirname,require,module,exports,Asx,babelHelpers){\n\n'+result.code+'\n\n});\n');
    });
    for(var d in dependencies){
        dependencies[d].used = dependants[d];
        if(!dependencies[d].used){
            console.info(d);
        }
    }
    fs.writeFileSync(path.resolve(out,'package.json'),JSON.stringify({
        name    : cfg.name,
        version : cfg.version,
        modules : dependencies,
        cjs     : cfg.cjs
    },null,'  '));
    fs.writeFileSync(path.resolve(config.out,cfg.name,'project.json'),JSON.stringify({
        latest   : cfg.version,
        versions : [cfg.version]
    },null,'  '));
    console.info(helpers)
}
function watch_main(){
    build_main();
}
function build_runtime(){
    var helpers = [].concat(config.helpers); var sources = [];
    var src  = path.resolve(config.src,config.runtime.name);
    var out  = path.resolve(config.out,'runtime.js');
    config.runtime.files.forEach(function(n){
        var file = path.resolve(src,n);
        var result = babel.transform(fs.readFileSync(file),{
            stage           : 0,
            blacklist       : ['strict'],
            modules         : 'ignore',
            moduleIds       : true,
            externalHelpers : true
        });
        sources.push(result.code);
        if(result.metadata.usedHelpers){
            result.metadata.usedHelpers.forEach(function(helper){
                if(helpers.indexOf(helper)<0){
                    helpers.push(helper);
                }
            })
        }
    });
    sources.unshift(babel.buildExternalHelpers(helpers,'var'));
    sources.unshift('(function(global){');
    sources.push('})(typeof global!="undefined"?global:self);');
    sources = sources.join('\n');
    fs.writeFileSync(out,sources);
}

makeDirRecursive(config.out)


if(process.argv.indexOf('runtime')>=0){
    build_runtime();
}
if(process.argv.indexOf('translator')>=0){
    build_main('translator');
}
if(process.argv.indexOf('compiler')>=0){
    build_main('compiler');
}