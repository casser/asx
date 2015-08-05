import * as messages from "../../messages";
import Remaps from "./lib/remaps";
import extend from "lodash/object/extend";
import object from "../../helpers/object";
import * as util from  "../../util";
import * as t from "../../types";

var metadataVisitor = {
  ModuleDeclaration: {
    enter(node, parent, scope, formatter) {
      if (node.source) {
        node.source.value = formatter.file.resolveModuleSource(node.source.value);
        formatter.addScope(this);
      }
    }
  },

  ImportDeclaration: {
    exit(node, parent, scope, formatter) {
      formatter.hasLocalImports = true;

      var specifiers = [];
      var imported = [];
      formatter.metadata.imports.push({
        source: node.source.value,
        imported,
        specifiers
      });

      for (var specifier of this.get("specifiers")) {
        var ids = specifier.getBindingIdentifiers();
        extend(formatter.localImports, ids);

        var local = specifier.node.local.name;

        if (specifier.isImportDefaultSpecifier()) {
          imported.push("default");
          specifiers.push({
            kind: "named",
            imported: "default",
            local
          });
        }

        if (specifier.isImportSpecifier()) {
          var importedName = specifier.node.imported.name;
          imported.push(importedName);
          specifiers.push({
            kind: "named",
            imported: importedName,
            local
          });
        }

        if (specifier.isImportNamespaceSpecifier()) {
          imported.push("*");
          specifiers.push({
            kind: "namespace",
            local
          });
        }
      }
    }
  },

  ExportDeclaration(node, parent, scope, formatter) {
    formatter.hasLocalExports = true;

    var source = node.source ? node.source.value : null;
    var exports = formatter.metadata.exports;

    // export function foo() {}
    // export var foo = "bar";
    var declar = this.get("declaration");
    if (declar.isStatement()) {
      var bindings = declar.getBindingIdentifiers();

      for (var name in bindings) {
        var binding = bindings[name];
        formatter._addExport(name, binding);

        exports.exported.push(name);
        exports.specifiers.push({
          kind: "local",
          local: name,
          exported: this.isExportDefaultDeclaration() ? "default" : name
        });
      }
    }

    if (this.isExportNamedDeclaration() && node.specifiers) {
      for (var specifier of node.specifiers) {
        var exported = specifier.exported.name;
        exports.exported.push(exported);

        // export foo from "bar";
        if (t.isExportDefaultSpecifier(specifier)) {
          exports.specifiers.push({
            kind: "external",
            local: exported,
            exported,
            source
          });
        }

        // export * as foo from "bar";
        if (t.isExportNamespaceSpecifier(specifier)) {
          exports.specifiers.push({
            kind: "external-namespace",
            exported,
            source
          });
        }

        var local = specifier.local;
        if (!local) continue;

        formatter._addExport(local.name, specifier.exported);

        // export { foo } from "bar";
        // export { foo as bar } from "bar";
        if (source) {
          exports.specifiers.push({
            kind: "external",
            local: local.name,
            exported,
            source
          });
        }

        // export { foo };
        // export { foo as bar };
        if (!source) {
          exports.specifiers.push({
            kind: "local",
            local: local.name,
            exported
          });
        }
      }
    }

    // export * from "bar";
    if (this.isExportAllDeclaration()) {
      exports.specifiers.push({
        kind: "external-all",
        source
      });
    }

    if (!t.isExportDefaultDeclaration(node) && !declar.isTypeAlias()) {
      var onlyDefault = node.specifiers && node.specifiers.length === 1 && t.isSpecifierDefault(node.specifiers[0]);
      if (!onlyDefault) {
        formatter.hasNonDefaultExports = true;
      }
    }
  },

  Scope(node, parent, scope, formatter) {
    if (!formatter.isLoose()) {
      this.skip();
    }
  }
};

export default class DefaultFormatter {
  constructor(file) {
    // object containg all module sources with the scope that they're contained in
    this.sourceScopes = object();

    // ids for use in module ids
    this.defaultIds = object();
    this.ids        = object();

    // contains reference aliases for live bindings
    this.remaps = new Remaps(file, this);

    this.scope = file.scope;
    this.file  = file;

    this.hasNonDefaultExports = false;

    this.hasLocalExports = false;
    this.hasLocalImports = false;

    this.localExports = object();
    this.localImports = object();

    this.metadata = file.metadata.modules;
    this.getMetadata();
  }

  addScope(path) {
    var source = path.node.source && path.node.source.value;
    if (!source) return;

    var existingScope = this.sourceScopes[source];
    if (existingScope && existingScope !== path.scope) {
      throw path.errorWithNode(messages.get("modulesDuplicateDeclarations"));
    }

    this.sourceScopes[source] = path.scope;
  }

  isModuleType(node, type) {
    var modules = this.file.dynamicImportTypes[type];
    return modules && modules.indexOf(node) >= 0;
  }

  transform() {
    this.remapAssignments();
  }

  doDefaultExportInterop(node) {
    return (t.isExportDefaultDeclaration(node) || t.isSpecifierDefault(node)) && !this.noInteropRequireExport && !this.hasNonDefaultExports;
  }

  getMetadata() {
    var has = false;
    for (var node of this.file.ast.program.body) {
      if (t.isModuleDeclaration(node)) {
        has = true;
        break;
      }
    }
    if (has || this.isLoose()) {
      this.file.path.traverse(metadataVisitor, this);
    }
  }

  remapAssignments() {
    if (this.hasLocalExports || this.hasLocalImports) {
      this.remaps.run();
    }
  }

  remapExportAssignment(node, exported) {
    var assign = node;

    for (var i = 0; i < exported.length; i++) {
      assign = t.assignmentExpression(
        "=",
        t.memberExpression(t.identifier("exports"), exported[i]),
        assign
      );
    }

    return assign;
  }

  _addExport(name, exported) {
    var info = this.localExports[name] = this.localExports[name] || {
      binding: this.scope.getBindingIdentifier(name),
      exported: []
    };
    info.exported.push(exported);
  }

  getExport(node, scope) {
    if (!t.isIdentifier(node)) return;

    var local = this.localExports[node.name];
    if (local && local.binding === scope.getBindingIdentifier(node.name)) {
      return local.exported;
    }
  }

  getModuleName() {
    var opts = this.file.opts;
    // moduleId is n/a if a `getModuleId()` is provided
    if (opts.moduleId && !opts.getModuleId) {
      return opts.moduleId;
    }

    var filenameRelative = opts.filenameRelative;
    var moduleName = "";

    if (opts.moduleRoot) {
      moduleName = opts.moduleRoot + "/";
    }

    if (!opts.filenameRelative) {
      return moduleName + opts.filename.replace(/^\//, "");
    }

    if (opts.sourceRoot) {
      // remove sourceRoot from filename
      var sourceRootRegEx = new RegExp("^" + opts.sourceRoot + "\/?");
      filenameRelative = filenameRelative.replace(sourceRootRegEx, "");
    }

    if (!opts.keepModuleIdExtensions) {
      // remove extension
      filenameRelative = filenameRelative.replace(/\.(\w*?)$/, "");
    }

    moduleName += filenameRelative;

    // normalize path separators
    moduleName = moduleName.replace(/\\/g, "/");

    if (opts.getModuleId) {
      // If return is falsy, assume they want us to use our generated default name
      return opts.getModuleId(moduleName) || moduleName;
    } else {
      return moduleName;
    }
  }

  _pushStatement(ref, nodes) {
    if (t.isClass(ref) || t.isFunction(ref)) {
      if (ref.id) {
        nodes.push(t.toStatement(ref));
        ref = ref.id;
      }
    }

    return ref;
  }

  _hoistExport(declar, assign, priority) {
    if (t.isFunctionDeclaration(declar)) {
      assign._blockHoist = priority || 2;
    }

    return assign;
  }

  getExternalReference(node, nodes) {
    var ids = this.ids;
    var id = node.source.value;

    if (ids[id]) {
      return ids[id];
    } else {
      return this.ids[id] = this._getExternalReference(node, nodes);
    }
  }

  checkExportIdentifier(node) {
    if (t.isIdentifier(node, { name: "__esModule" })) {
      throw this.file.errorWithNode(node, messages.get("modulesIllegalExportName", node.name));
    }
  }

  exportAllDeclaration(node, nodes) {
    var ref = this.getExternalReference(node, nodes);
    nodes.push(this.buildExportsWildcard(ref, node));
  }

  isLoose() {
    return this.file.isLoose("es6.modules");
  }

  exportSpecifier(specifier, node, nodes) {
    if (node.source) {
      var ref = this.getExternalReference(node, nodes);

      if (specifier.local.name === "default" && !this.noInteropRequireExport) {
        // importing a default so we need to normalize it
        ref = t.callExpression(this.file.addHelper("interop-require"), [ref]);
      } else {
        ref = t.memberExpression(ref, specifier.local);

        if (!this.isLoose()) {
          nodes.push(this.buildExportsFromAssignment(specifier.exported, ref, node));
          return;
        }
      }

      // export { foo } from "test";
      nodes.push(this.buildExportsAssignment(specifier.exported, ref, node));
    } else {
      // export { foo };
      nodes.push(this.buildExportsAssignment(specifier.exported, specifier.local, node));
    }
  }

  buildExportsWildcard(objectIdentifier) {
    return t.expressionStatement(t.callExpression(this.file.addHelper("defaults"), [
      t.identifier("exports"),
      t.callExpression(this.file.addHelper("interop-require-wildcard"), [objectIdentifier])
    ]));
  }

  buildExportsFromAssignment(id, init) {
    this.checkExportIdentifier(id);
    return util.template("exports-from-assign", {
      INIT: init,
      ID:   t.literal(id.name)
    }, true);
  }

  buildExportsAssignment(id, init) {
    this.checkExportIdentifier(id);
    return util.template("exports-assign", {
      VALUE: init,
      KEY:   id
    }, true);
  }

  exportDeclaration(node, nodes) {
    var declar = node.declaration;

    var id = declar.id;

    if (t.isExportDefaultDeclaration(node)) {
      id = t.identifier("default");
    }

    var assign;

    if (t.isVariableDeclaration(declar)) {
      for (var i = 0; i < declar.declarations.length; i++) {
        var decl = declar.declarations[i];

        decl.init = this.buildExportsAssignment(decl.id, decl.init, node).expression;

        var newDeclar = t.variableDeclaration(declar.kind, [decl]);
        if (i === 0) t.inherits(newDeclar, declar);
        nodes.push(newDeclar);
      }
    } else {
      var ref = declar;

      if (t.isFunctionDeclaration(declar) || t.isClassDeclaration(declar)) {
        ref = declar.id;
        nodes.push(declar);
      }

      assign = this.buildExportsAssignment(id, ref, node);

      nodes.push(assign);

      this._hoistExport(declar, assign);
    }
  }
}
