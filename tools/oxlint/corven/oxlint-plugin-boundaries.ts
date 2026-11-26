import { definePlugin, defineRule } from "@oxlint/plugins";
import type { Context, Definition, ESTree, Scope, Variable } from "@oxlint/plugins";
import {
  sdkDevelopmentSource,
  sdkImportPath,
  sdkIntegrationSource,
  sdkRepositoryPath,
  sdkRuntimeSource,
} from "./sdk-lint-paths.ts";

type RuleContext = Context;

type NodeOfType<Type extends ESTree.Node["type"]> = Extract<ESTree.Node, { type: Type }>;

type PropertyNode = NodeOfType<"Property">;

type StaticKeyValue = NodeOfType<"Literal">["value"] | null;

const surfaceConstructorNames = new Set([
  "HttpApi",
  "HttpApiEndpoint",
  "HttpApiGroup",
  "Rpc",
  "RpcGroup",
  "Tool",
  "Toolkit",
]);

const unwrapExpression = (node: ESTree.Expression): ESTree.Expression => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSInstantiationExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    return unwrapExpression(node.expression);
  }

  return node;
};

const isStringModule = (node: ESTree.Expression): string | null => {
  const expression = unwrapExpression(node);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers and booleans, so module sources need a string boundary check.
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }

  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
    const value = expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw;

    return value ?? null;
  }

  return null;
};

const staticPropertyKeyName = (node: PropertyNode): string | undefined => {
  if (!node.computed && node.key.type === "Identifier") {
    return node.key.name;
  }

  let value: StaticKeyValue = null;

  if (node.computed && node.key.type === "Literal") {
    const { value: literalValue } = node.key;
    value = literalValue;
  }

  if (node.computed && node.key.type === "TemplateLiteral" && node.key.expressions.length === 0) {
    const [firstQuasi] = node.key.quasis;
    value = firstQuasi?.value.cooked ?? firstQuasi?.value.raw ?? null;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers and booleans, so object keys need a string check.
  return typeof value === "string" ? value : undefined;
};

const staticPropertyName = (node: ESTree.MemberExpression) => {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }

  let value: StaticKeyValue = null;

  if (node.computed && node.property.type === "Literal") {
    const { value: literalValue } = node.property;
    value = literalValue;
  }

  if (
    node.computed &&
    node.property.type === "TemplateLiteral" &&
    node.property.expressions.length === 0
  ) {
    const [firstQuasi] = node.property.quasis;
    value = firstQuasi?.value.cooked ?? firstQuasi?.value.raw ?? null;
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers, booleans, and regexes, so a computed key needs a string check.
  return typeof value === "string" ? value : undefined;
};

const importedName = (node: ESTree.ImportDeclaration["specifiers"][number]): string | null => {
  if (node.type !== "ImportSpecifier") {
    return null;
  }

  if (node.imported.type === "Identifier") {
    return node.imported.name;
  }

  return node.imported.value;
};

const variableOf = (name: string, scope: Scope | null): Variable | undefined =>
  scope === null ? undefined : (scope.set.get(name) ?? variableOf(name, scope.upper));

const isStableVariable = (variable: Variable) =>
  variable.references.every((reference) => !reference.isWrite() || reference.init);

interface ImportIdentity {
  readonly module: string;
  readonly name: string | null;
}

const importIdentity = (
  expression: ESTree.Expression,
  scope: Scope | null,
  context: RuleContext,
  seen = new Set<Definition["node"]>(),
): ImportIdentity | null => {
  const requireFunction = (
    candidate: ESTree.Expression,
    candidateScope: Scope | null,
    visited = new Set<Definition["node"]>(),
  ): boolean => {
    const requireBinding = (name: string, bindingScope: Scope | null) => {
      const variable = variableOf(name, bindingScope);

      if (variable === undefined) {
        return name === "require";
      }

      const [definition] = variable.defs;

      if (
        definition?.type !== "Variable" ||
        definition.node.type !== "VariableDeclarator" ||
        definition.node.init === null ||
        !isStableVariable(variable) ||
        visited.has(definition.node)
      ) {
        return false;
      }

      visited.add(definition.node);

      const declarationScope = context.sourceCode.getScope(definition.node);

      if (definition.node.id.type === "ObjectPattern") {
        const initializer = unwrapExpression(definition.node.init);

        return (
          initializer.type === "Identifier" &&
          initializer.name === "module" &&
          variableOf("module", declarationScope) === undefined &&
          definition.node.id.properties.some(
            (property) =>
              property.type === "Property" &&
              property.value.type === "Identifier" &&
              property.value.name === name &&
              staticPropertyKeyName(property) === "require",
          )
        );
      }

      if (definition.node.id.type !== "Identifier") {
        return false;
      }

      return requireFunction(definition.node.init, declarationScope, visited);
    };

    const target = unwrapExpression(candidate);

    if (target.type === "Identifier") {
      return requireBinding(target.name, candidateScope);
    }

    if (target.type === "MemberExpression") {
      return (
        staticPropertyName(target) === "require" &&
        target.object.type === "Identifier" &&
        target.object.name === "module" &&
        variableOf("module", candidateScope) === undefined
      );
    }

    if (target.type === "CallExpression") {
      const identity = importIdentity(target.callee, candidateScope, context, visited);

      return (
        identity?.name === "createRequire" &&
        (identity.module === "module" || identity.module === "node:module")
      );
    }

    return false;
  };

  const loadedModuleIdentity = (
    candidate: ESTree.Expression,
    candidateScope: Scope | null,
  ): ImportIdentity | null => {
    const target = unwrapExpression(candidate);

    if (target.type === "AwaitExpression") {
      return loadedModuleIdentity(target.argument, candidateScope);
    }

    if (target.type === "ImportExpression") {
      const module = isStringModule(target.source);

      return module === null ? null : { module, name: null };
    }

    if (target.type !== "CallExpression") {
      return null;
    }

    const [argument] = target.arguments;

    if (
      argument === undefined ||
      argument.type === "SpreadElement" ||
      !requireFunction(target.callee, candidateScope)
    ) {
      return null;
    }

    const module = isStringModule(argument);

    return module === null ? null : { module, name: null };
  };

  const importBindingIdentity = (definition: Definition): ImportIdentity | null => {
    const { parent } = definition.node;

    if (definition.type !== "ImportBinding" || parent?.type !== "ImportDeclaration") {
      return null;
    }

    const module = isStringModule(parent.source);

    if (module === null) {
      return null;
    }

    return {
      module,
      name: definition.node.type === "ImportSpecifier" ? importedName(definition.node) : null,
    };
  };

  const importIdentityForPattern = (
    name: string,
    pattern: ESTree.ObjectPattern,
    initializer: ESTree.Expression,
    patternScope: Scope | null,
  ): ImportIdentity | null => {
    const property = pattern.properties.find(
      (item) =>
        item.type === "Property" && item.value.type === "Identifier" && item.value.name === name,
    );

    if (property?.type !== "Property") {
      return null;
    }

    const imported = staticPropertyKeyName(property);
    const namespace = importIdentity(initializer, patternScope, context, seen);

    if (
      namespace === null ||
      (namespace.name !== null && !surfaceConstructorNames.has(namespace.name)) ||
      imported === undefined
    ) {
      return null;
    }

    const module =
      namespace.name === null ? namespace.module : `${namespace.module}/${namespace.name}`;

    return { module, name: imported };
  };

  const importIdentityForVariable = (name: string, variable: Variable): ImportIdentity | null => {
    const [definition] = variable.defs;

    if (definition === undefined || seen.has(definition.node)) {
      return null;
    }

    seen.add(definition.node);

    const imported = importBindingIdentity(definition);

    if (imported !== null) {
      return imported;
    }

    if (
      definition.type !== "Variable" ||
      definition.node.type !== "VariableDeclarator" ||
      !isStableVariable(variable) ||
      definition.node.init === null
    ) {
      return null;
    }

    const initializer = definition.node.init;
    const declarationScope = context.sourceCode.getScope(definition.node);

    if (definition.node.id.type === "ObjectPattern") {
      return importIdentityForPattern(name, definition.node.id, initializer, declarationScope);
    }

    return importIdentity(initializer, declarationScope, context, seen);
  };

  const loadedModule = loadedModuleIdentity(expression, scope);

  if (loadedModule !== null) {
    return loadedModule;
  }

  const value = unwrapExpression(expression);

  if (value.type === "Identifier") {
    const variable = variableOf(value.name, scope);

    return variable === undefined ? null : importIdentityForVariable(value.name, variable);
  }

  if (value.type === "MemberExpression") {
    const object = importIdentity(value.object, scope, context, seen);
    const name = staticPropertyName(value);

    return object !== null &&
      (object.name === null || surfaceConstructorNames.has(object.name)) &&
      name !== undefined
      ? {
          module: object.name === null ? object.module : `${object.module}/${object.name}`,
          name,
        }
      : null;
  }

  return null;
};

const isTypeOnlyDefinition = (definition: Definition) => {
  if (
    definition.node.type === "TSInterfaceDeclaration" ||
    definition.node.type === "TSTypeAliasDeclaration"
  ) {
    return true;
  }

  if (definition.type === "ImportBinding") {
    const { parent } = definition.node;

    if (
      parent?.type === "ImportDeclaration" &&
      (parent.importKind === "type" ||
        (definition.node.type === "ImportSpecifier" && definition.node.importKind === "type"))
    ) {
      return true;
    }
  }

  return (
    definition.node.type === "VariableDeclarator" &&
    definition.node.parent.type === "VariableDeclaration" &&
    definition.node.parent.declare === true
  );
};

const isDeclaredLocally = (name: string, scope: Scope | null): boolean =>
  scope !== null &&
  ((scope.set.get(name)?.defs.some((definition) => !isTypeOnlyDefinition(definition)) ?? false) ||
    isDeclaredLocally(name, scope.upper));

const isReference = (node: ESTree.Node, scope: Scope | null): boolean =>
  scope !== null &&
  (scope.references.some((reference) => reference.identifier === node) ||
    scope.through.some((reference) => reference.identifier === node) ||
    isReference(node, scope.upper));

const isTypePosition = (node: ESTree.Node): boolean => {
  let current = node;

  while (true) {
    const { parent } = current;

    if (parent === null) {
      return false;
    }

    if (
      parent.type === "TSTypeAnnotation" ||
      parent.type === "TSTypeReference" ||
      parent.type === "TSQualifiedName" ||
      parent.type === "TSTypeQuery" ||
      parent.type === "TSImportType" ||
      parent.type === "TSInterfaceDeclaration" ||
      parent.type === "TSTypeAliasDeclaration"
    ) {
      return true;
    }

    current = parent;
  }
};

const globalObjects = new Set(["global", "globalThis", "self", "window"]);

const resolvesGlobalObject = (
  expression: ESTree.Expression,
  scope: Scope | null,
  context: RuleContext,
  seen = new Set<Definition["node"]>(),
): boolean => {
  const value = unwrapExpression(expression);

  if (value.type !== "Identifier") {
    return false;
  }

  const variable = variableOf(value.name, scope);
  const definition = variable?.defs[0];

  if (definition === undefined) {
    return globalObjects.has(value.name);
  }

  if (seen.has(definition.node)) {
    return false;
  }

  seen.add(definition.node);

  return (
    definition.type === "Variable" &&
    definition.node.type === "VariableDeclarator" &&
    definition.node.id.type === "Identifier" &&
    definition.node.init !== null &&
    variable !== undefined &&
    isStableVariable(variable) &&
    resolvesGlobalObject(
      definition.node.init,
      context.sourceCode.getScope(definition.node),
      context,
      seen,
    )
  );
};

const isRequireFunction = (
  expression: ESTree.Expression,
  scope: Scope,
  context: RuleContext,
  seen = new Set<Definition["node"]>(),
): boolean => {
  const isRequireBinding = (name: string, bindingScope: Scope): boolean => {
    const variable = variableOf(name, bindingScope);

    if (name === "require" && variable === undefined) {
      return true;
    }

    const [definition] = variable?.defs ?? [];

    if (
      variable === undefined ||
      definition === undefined ||
      definition.type !== "Variable" ||
      definition.node.type !== "VariableDeclarator" ||
      definition.node.init === null ||
      !isStableVariable(variable) ||
      seen.has(definition.node)
    ) {
      return false;
    }

    seen.add(definition.node);

    const declarationScope = context.sourceCode.getScope(definition.node);

    if (definition.node.id.type === "ObjectPattern") {
      const initializer = unwrapExpression(definition.node.init);

      return (
        initializer.type === "Identifier" &&
        initializer.name === "module" &&
        variableOf("module", declarationScope) === undefined &&
        definition.node.id.properties.some(
          (property) =>
            property.type === "Property" &&
            property.value.type === "Identifier" &&
            property.value.name === name &&
            staticPropertyKeyName(property) === "require",
        )
      );
    }

    if (definition.node.id.type !== "Identifier") {
      return false;
    }

    return isRequireFunction(definition.node.init, declarationScope, context, seen);
  };

  const value = unwrapExpression(expression);

  if (value.type === "CallExpression") {
    const identity = importIdentity(value.callee, scope, context);

    return (
      identity?.name === "createRequire" &&
      (identity.module === "module" || identity.module === "node:module")
    );
  }

  if (value.type === "Identifier") {
    return isRequireBinding(value.name, scope);
  }

  return (
    value.type === "MemberExpression" &&
    staticPropertyName(value) === "require" &&
    value.object.type === "Identifier" &&
    value.object.name === "module" &&
    !isDeclaredLocally(value.object.name, scope)
  );
};

const moduleSourceVisitors = (
  context: RuleContext,
  report: (node: ESTree.Node, source: ESTree.Expression) => void,
) => ({
  CallExpression(node: ESTree.CallExpression) {
    const [argument] = node.arguments;

    if (
      argument !== undefined &&
      argument.type !== "SpreadElement" &&
      isRequireFunction(node.callee, context.sourceCode.getScope(node), context)
    ) {
      report(node, argument);
    }
  },
  ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
    report(node, node.source);
  },
  ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
    if (node.source !== null) {
      report(node, node.source);
    }
  },
  ImportDeclaration(node: ESTree.ImportDeclaration) {
    report(node, node.source);
  },
  ImportExpression(node: ESTree.ImportExpression) {
    report(node, node.source);
  },
  TSImportEqualsDeclaration(node: ESTree.TSImportEqualsDeclaration) {
    if (node.moduleReference.type === "TSExternalModuleReference") {
      report(node, node.moduleReference.expression);
    }
  },
  TSImportType(node: ESTree.TSImportType) {
    report(node, node.source);
  },
});

const noCrossLayerImports = defineRule({
  create(context) {
    const filename = sdkRepositoryPath(context.filename);

    if (!sdkRuntimeSource(filename)) {
      return {};
    }

    return moduleSourceVisitors(context, (node, source) => {
      const specifier = isStringModule(source);
      const target = specifier === null ? null : sdkImportPath(filename, specifier);

      if (target !== null && !target.startsWith("src/")) {
        context.report({ messageId: "sourceOwner", node });
      }
    });
  },
  meta: {
    docs: {
      description: "Keep SDK runtime imports inside src rather than repository tooling or examples.",
    },
    messages: {
      sourceOwner:
        "SDK runtime code cannot import tests, examples, tooling, documentation, or reference repositories. Move shared runtime behavior into src.",
    },
    type: "problem",
  },
});

const noCoreAdapters = defineRule({
  create(context) {
    const filename = sdkRepositoryPath(context.filename);

    if (!sdkRuntimeSource(filename) || sdkIntegrationSource(filename)) {
      return {};
    }

    return moduleSourceVisitors(context, (node, source) => {
      const specifier = isStringModule(source);

      if (specifier === null) {
        return;
      }

      const target = sdkImportPath(filename, specifier);
      const domainModule =
        target !== null && sdkRuntimeSource(target) && !sdkIntegrationSource(target);
      const domainLibrary = /^effect(?:\/|$)/u.test(specifier) || specifier === "node:buffer";
      const transportModule =
        /^effect\/(?:unstable\/)?(?:ai|cli|cluster|eventlog|http[^/]*|net|observability|persistence|process|reactivity|rpc|socket|sql|workers|workflow)(?:\/|$)/u.test(
          specifier,
        );
      const adapterModule = /(?:^|\/)(?:adapters?|vendors?)(?:\/|$)/u.test(target ?? specifier);

      if ((!domainModule && !domainLibrary) || transportModule || adapterModule) {
        context.report({ messageId: "coreAdapter", node });
      }
    });
  },
  meta: {
    docs: {
      description: "Keep SDK domain and operation policy independent of concrete runtime adapters.",
    },
    messages: {
      coreAdapter:
        "SDK domain code cannot import transports, framework or provider adapters, or their composition roots. Depend on a domain capability; wire concrete adapters at an explicitly owned integration boundary.",
    },
    type: "problem",
  },
});

const surfaceConstructors = new Map<string, ReadonlySet<string>>([
  ["HttpApi", new Set(["make"])],
  [
    "HttpApiEndpoint",
    new Set(["del", "delete", "get", "head", "make", "options", "patch", "post", "put"]),
  ],
  ["HttpApiGroup", new Set(["make"])],
  ["Rpc", new Set(["make"])],
  ["RpcGroup", new Set(["make"])],
  ["Tool", new Set(["make"])],
  ["Toolkit", new Set(["make"])],
]);

const surfaceConstructorName = (
  expression: ESTree.Expression,
  scope: Scope,
  context: RuleContext,
): string | null => {
  const object = unwrapExpression(expression);

  if (object.type === "MemberExpression") {
    const name = staticPropertyName(object);

    return name !== undefined && surfaceConstructors.has(name) ? name : null;
  }

  if (object.type !== "Identifier") {
    return null;
  }

  const identity = importIdentity(object, scope, context);

  if (identity === null) {
    return null;
  }

  if (identity.name !== null && surfaceConstructors.has(identity.name)) {
    return identity.name;
  }

  const moduleName = identity.module.split("/").at(-1);

  return moduleName !== undefined && surfaceConstructors.has(moduleName) ? moduleName : null;
};

const surfaceCallName = (
  expression: ESTree.Expression,
  scope: Scope,
  context: RuleContext,
): string | null => {
  const callee = unwrapExpression(expression);

  if (callee.type === "MemberExpression") {
    const method = staticPropertyName(callee);
    const constructor = surfaceConstructorName(callee.object, scope, context);

    return method !== undefined &&
      constructor !== null &&
      surfaceConstructors.get(constructor)?.has(method) === true
      ? `${constructor}.${method}`
      : null;
  }

  if (callee.type !== "Identifier") {
    return null;
  }

  const identity = importIdentity(callee, scope, context);
  const moduleName = identity?.module.split("/").at(-1);

  return identity?.name !== null &&
    identity?.name !== undefined &&
    moduleName !== undefined &&
    surfaceConstructors.get(moduleName)?.has(identity.name) === true
    ? `${moduleName}.${identity.name}`
    : null;
};

const noHandRolledSurface = defineRule({
  create(context) {
    return {
      CallExpression(node) {
        let callee = unwrapExpression(node.callee);

        if (
          callee.type === "MemberExpression" &&
          ["apply", "call"].includes(staticPropertyName(callee) ?? "")
        ) {
          callee = unwrapExpression(callee.object);
        }

        const call = surfaceCallName(callee, context.sourceCode.getScope(node), context);

        if (call !== null) {
          context.report({
            data: { call },
            messageId: "handRolled",
            node,
          });
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Keep transport surfaces outside the SDK's email operation and approval contracts.",
    },
    messages: {
      handRolled:
        "{{call}} hand-rolls a transport surface. Expose email operations through the SDK service or host-reviewed agent contract; keep HTTP, RPC, and framework transport wiring in the consuming application.",
    },
    type: "problem",
  },
});

const browserGlobals = new Set([
  "document",
  "localStorage",
  "navigator",
  "sessionStorage",
  "window",
]);

const noBrowserGlobalsOnServer = defineRule({
  create(context) {
    if (!sdkRuntimeSource(sdkRepositoryPath(context.filename))) {
      return {};
    }

    const report = (node: ESTree.Node, name: string) => {
      context.report({
        data: { name },
        messageId: "browserGlobal",
        node,
      });
    };

    return {
      Identifier(node) {
        if (
          !browserGlobals.has(node.name) ||
          isTypePosition(node) ||
          !isReference(node, context.sourceCode.getScope(node)) ||
          isDeclaredLocally(node.name, context.sourceCode.getScope(node))
        ) {
          return;
        }

        const { parent } = node;

        if (
          (parent.type === "MemberExpression" &&
            (parent.object === node || (parent.property === node && !parent.computed))) ||
          (parent.type === "Property" &&
            parent.key === node &&
            !parent.computed &&
            !parent.shorthand) ||
          (parent.type === "UnaryExpression" && parent.operator === "typeof")
        ) {
          return;
        }

        report(node, node.name);
      },
      MemberExpression(node) {
        const scope = context.sourceCode.getScope(node);

        if (
          node.object.type === "Identifier" &&
          browserGlobals.has(node.object.name) &&
          !isDeclaredLocally(node.object.name, scope)
        ) {
          report(node.object, node.object.name);

          return;
        }

        const property = staticPropertyName(node);

        if (
          property !== undefined &&
          browserGlobals.has(property) &&
          resolvesGlobalObject(node.object, scope, context)
        ) {
          report(node.property, property);
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type !== "ObjectPattern" ||
          node.init === null ||
          !resolvesGlobalObject(node.init, context.sourceCode.getScope(node), context)
        ) {
          return;
        }

        for (const property of node.id.properties) {
          if (property.type !== "Property") {
            continue;
          }

          const name = staticPropertyKeyName(property);

          if (name !== undefined && browserGlobals.has(name)) {
            report(property.key, name);
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Keep browser-only globals out of SDK runtime modules.",
    },
    messages: {
      browserGlobal:
        "{{name}} exists only in a browser. SDK runtime code must work without browser globals; supply host capabilities explicitly.",
    },
    type: "problem",
  },
});

const noDevtoolsInProduction = defineRule({
  create(context) {
    const filename = sdkRepositoryPath(context.filename);

    if (!sdkRuntimeSource(filename)) {
      return {};
    }

    return moduleSourceVisitors(context, (node, source) => {
      const specifier = isStringModule(source);

      if (specifier === null) {
        return;
      }

      const target = sdkImportPath(filename, specifier);
      const developmentLibrary =
        /^(?:@effect\/(?:vitest|devtools)|@oxlint\/plugins|vitest|fast-check|effect\/(?:devtools|testing))(?:\/|$)/u.test(specifier);

      if (developmentLibrary || (target !== null && sdkDevelopmentSource(target))) {
        context.report({ messageId: "devtools", node });
      }
    });
  },
  meta: {
    docs: {
      description: "Keep test fixtures and development-only libraries out of SDK runtime modules.",
    },
    messages: {
      devtools:
        "SDK runtime code cannot import test fixtures or development-only libraries. Keep test acquisition in tests and expose intentional recording/failing senders through their existing SDK capabilities.",
    },
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "rat-stack-boundaries" },
  rules: {
    "no-browser-globals-on-server": noBrowserGlobalsOnServer,
    "no-core-adapters": noCoreAdapters,
    "no-cross-layer-imports": noCrossLayerImports,
    "no-devtools-in-production": noDevtoolsInProduction,
    "no-hand-rolled-surface": noHandRolledSurface,
  },
});
