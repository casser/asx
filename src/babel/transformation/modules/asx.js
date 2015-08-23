import DefaultFormatter from "./_default";
import CommonFormatter from "./common";
import includes from "lodash/collection/includes";
import values from "lodash/object/values";
import * as util from  "../../util";
import * as t from "../../types";
import ast from "../../helpers/ast-utils";

export default class AsxFormatter extends DefaultFormatter {
    static options(ast) {
        var options = {};
        if (ast.comments && ast.comments.length) {
            var comment = ast.comments.shift();
            if (comment.type == 'Block') {
                options = comment.value.match(/\*\s*@module\s+(\{[^}]*\})/g);
                if (options) {
                    options = options[0].split('\n').map(l=> {
                        return l.replace(/\s*\*(.*)/, '$1').trim()
                    });
                    options = options.join(' ').replace(/\s*\@module\s*/, '');
                    options = (new Function('return ' + options + ';'))();
                }
            } else {
                ast.comments.unshift(comment);
            }
        }
        return options || {};
    }

    moduleId:String;
    project:Project;

    constructor(file) {
        super(file);
        this.project = this.file.project;
        this.moduleId = this.file.opts.moduleId;
        this.imports = {};
        this.proxies = {};
        this.exports = {};
    }
    getImport(name) {
        name = this.project.resolveModule(
            this.moduleId, name
        );
        if (!this.imports[name]) {
            this.imports[name] = {}
        }
        return this.imports[name];
    }
    getExport(name) {
        var isSelf = (!name || name == this.moduleId);
        if(isSelf){
           return this.exports;
        }
        var exports = this.proxies;
        name = this.file.project.resolveModule(
            this.moduleId, name || this.moduleId
        );
        exports = this.proxies;
        if (!exports[name]) {
            exports[name] = {}
        }
        return exports[name];
    }

    transform(program) {
        var options = AsxFormatter.options(this.file.ast);
        var locals = [];
        var classes=[],methods=[],fields=[],definitions;
        var body = [];
        var execution = [];
        program.body.forEach(item=> {
            switch (item.type) {
                case 'VariableDeclaration':
                    if(item._const){
                        item.declarations.forEach(d=>{
                            fields.push(this.convertField(d));
                        });
                        return;
                    }
                break;
                case 'FunctionDeclaration':
                    if(item._class){
                        classes.push(this.convertClass(item));
                    }else{
                        methods.push(this.convertMethod(item));
                    }
                    return;
                break;
            }
            execution.push(item);
        });
        definitions = [].concat(fields).concat(methods).concat(classes);

        if(this.defaultExport){
            execution.push(t.returnStatement(this.defaultExport));
        }
        if(execution.length){

            definitions.unshift(t.property('init',t.identifier('default'),
                t.functionExpression(null, [], t.blockStatement(execution))
            ));
        }
        this.project.module(this.moduleId,{
            imports: this.imports,
            proxies: this.proxies,
            exports: this.exports
        });


        var definer,oe;
        if(definitions.length){
            body.push(t.returnStatement(t.assignmentExpression('=',t.identifier('__'),
                t.callExpression(t.identifier('__'),[oe=t.objectExpression(definitions)])
            )));
        }
        if (body.length) {
            definer = t.functionExpression(null, [t.identifier('__')], t.blockStatement([
                t.withStatement(t.identifier('this'), t.blockStatement(body))
            ]));
        }
        body = [];
        definer = util.template("asx-module", {
            MODULE_NAME: t.literal(this.moduleId),
            MODULE_BODY: definer
        });
        body.push(t.expressionStatement(definer));

        oe._compact = false;
        program._compact = true;
        program.body = body;
    }
    convertField(field){
        var p = [],d=[],v,f;
        if(field.id.typeAnnotation){
            d.push(ast.convertType(field.id.typeAnnotation.typeAnnotation));
        }

        if(field.init){
            p.push(t.property("init", t.identifier("V"),v=t.functionExpression(field.id, [], t.blockStatement([
                t.returnStatement(field.init)
            ]))));
        }
        if(d.length){
            p.push(t.property("init", ast.decoratorId,ast.convertDecorators(d)));
        }
        f = t.objectExpression(p);
        //f._compact = true;
        //v._compact = false;
        return t.property('init',field.id,f);
    }
    convertMethod(method){
        var p = [],d=[];
        method._compact = false;
        if(method.returnType){
            d.push(ast.convertType(method.returnType.typeAnnotation));
        }
        if(method.params && method.params.length){
            d.push(ast.convertArguments(method.params));
        }
        var def = t.objectExpression(p);
        //def._compact=true;
        p.push(t.property("init", t.identifier("F"), method));

        if(d.length){
            p.push(t.property("init", ast.decoratorId,ast.convertDecorators(d)));
        }

        p = t.property('init',method.id,def);
        //method.id = null;

        return p;

    }
    convertMethodParam(param,rests) {
        var name, args, rest = false;
        if (param.type == 'RestElement') {
            name = param.argument;
            rests.push(name);
        } else
        if (param.type == 'AssignmentPattern') {
            name = param.left;
        } else {
            name = param;
        }
        if (param.typeAnnotation) {
            args = ast.convertType(param.typeAnnotation.typeAnnotation)
        } else {
            args = ast.convertType(t.genericTypeAnnotation(t.identifier('Object')))
        }
        return t.property("init", name, args)
    }

    convertClass(closure){
        var properties = t.property('init',closure.id,closure);
        closure.id = null;
        return properties;
    }
    importDeclaration(node) {
        this.getImport(node.source.value)['*'] = '*';
    }
    importSpecifier(specifier, node, nodes) {
        var imp = this.getImport(node.source.value);
        switch (specifier.type) {
            case 'ImportNamespaceSpecifier' :
                imp['*'] = specifier.local.name;
                break;
            case 'ImportDefaultSpecifier' :
                imp['default'] = specifier.local.name;
                break;
            case 'ImportSpecifier' :
                var imported = specifier.imported.name;
                var local = specifier.local.name;
                if (imported == local) {
                    imp[imported] = '*';
                } else {
                    imp[imported] = local;
                }
                break;
        }
    }
    exportAllDeclaration(node, nodes) {
        this.getExport(node.source.value)['*'] = '*';
    }
    exportDeclaration(node, nodes) {
        switch (node.type) {
            case 'ExportDefaultDeclaration' :
                this.exports.default = '*';
                this.defaultExport = node.declaration;
        }
    }
    exportSpecifier(specifier, node, nodes) {
        var exp = this.getExport(node.source ? node.source.value : false);
        switch (specifier.type) {
            case 'ExportSpecifier' :
                var exported = specifier.exported.name;
                var local = specifier.local.name;
                exp[exported] = local == exported ? '*' : local;
                break;
            default :
                JSON.ast_print(specifier);
                break;
        }
    }
}
