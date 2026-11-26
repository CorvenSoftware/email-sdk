import { definePlugin, defineRule } from "@oxlint/plugins";
import type { Context, Definition, ESTree, Scope, Variable } from "@oxlint/plugins";
import { sdkRepositoryPath, sdkRuntimeSource } from "./sdk-lint-paths.ts";

type RuleContext = Context;

type NodeOfType<Type extends ESTree.Node["type"]> = Extract<ESTree.Node, { type: Type }>;

type AssignmentPatternNode = ESTree.AssignmentPattern;

type ReturnStatementNode = NodeOfType<"ReturnStatement">;

type FunctionThunk = ESTree.ArrowFunctionExpression | ESTree.Function;

const unwrapExpression = (node: ESTree.Expression): ESTree.Expression => {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "ChainExpression" ||
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

const staticPropertyName = (node: ESTree.MemberExpression): string | null => {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }

  if (node.property.type === "Literal") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers, booleans, and regexes, so computed API names need a string check.
    return typeof node.property.value === "string" ? node.property.value : null;
  }

  if (node.property.type === "TemplateLiteral" && node.property.expressions.length === 0) {
    const [firstQuasi] = node.property.quasis;

    return firstQuasi?.value.cooked ?? firstQuasi?.value.raw ?? null;
  }

  return null;
};

const staticPropertyKeyName = (
  node: ESTree.ObjectProperty | ESTree.BindingProperty,
): string | null => {
  if (!node.computed && node.key.type === "Identifier") {
    return node.key.name;
  }

  if (node.key.type === "Literal") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers and booleans, so destructuring keys need a string check.
    return typeof node.key.value === "string" ? node.key.value : null;
  }

  if (node.key.type === "TemplateLiteral" && node.key.expressions.length === 0) {
    const [firstQuasi] = node.key.quasis;

    return firstQuasi?.value.cooked ?? firstQuasi?.value.raw ?? null;
  }

  return null;
};

const stringValue = (node: ESTree.Expression): string | null => {
  const expression = unwrapExpression(node);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree Literal also represents numbers and booleans, so contract names need a string check.
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }

  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw ?? null;
  }

  return null;
};

const variableOf = (name: string, scope: Scope | null): Variable | undefined =>
  scope === null ? undefined : (scope.set.get(name) ?? variableOf(name, scope.upper));

const declarationOf = (name: string, scope: Scope | null): Definition | undefined =>
  variableOf(name, scope)?.defs[0];

const isStableVariable = (variable: Variable) =>
  variable.references.every((reference) => !reference.isWrite() || reference.init);

const importedName = (node: ESTree.ImportSpecifier) =>
  node.imported.type === "Identifier" ? node.imported.name : node.imported.value;

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
      const module = stringValue(target.source);

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

    const module = stringValue(argument);

    return module === null ? null : { module, name: null };
  };

  const importBindingIdentity = (definition: Definition): ImportIdentity | null => {
    const { parent } = definition.node;

    if (definition.type !== "ImportBinding" || parent?.type !== "ImportDeclaration") {
      return null;
    }

    const module = stringValue(parent.source);

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
      (namespace.name !== null && namespace.name !== "Effect") ||
      imported === null
    ) {
      return null;
    }

    return {
      module: namespace.name === null ? namespace.module : `${namespace.module}/${namespace.name}`,
      name: imported,
    };
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

    if (object === null || (object.name !== null && object.name !== "Effect") || name === null) {
      return null;
    }

    return { module: object.module, name };
  }

  return null;
};

const isEffectCall = (node: ESTree.Node, member: string, context: RuleContext) => {
  const expression = node.type === "CallExpression" ? node : null;

  if (expression === null) {
    return false;
  }

  const callee = unwrapExpression(expression.callee);
  const scope = context.sourceCode.getScope(expression);

  if (callee.type === "Identifier") {
    const identity = importIdentity(callee, scope, context);

    return (
      identity !== null &&
      (identity.module === "effect" || identity.module.startsWith("effect/")) &&
      identity.name === member
    );
  }

  if (callee.type !== "MemberExpression" || staticPropertyName(callee) !== member) {
    return false;
  }

  const identity = importIdentity(callee.object, scope, context);

  return (
    identity !== null &&
    (identity.module === "effect" || identity.module.startsWith("effect/")) &&
    (identity.name === "Effect" || identity.name === null)
  );
};

const cacheConstructors = ["cached", "cachedWithTTL", "cachedInvalidateWithTTL"];

const isInitializationCall = (node: ESTree.CallExpression, context: RuleContext) => {
  const scope = context.sourceCode.getScope(node);
  const identity = importIdentity(node.callee, scope, context);

  if (identity?.module.startsWith("alchemy") === true) {
    return true;
  }

  if (node.callee.type !== "MemberExpression") {
    return false;
  }

  const object = importIdentity(node.callee.object, scope, context);

  return (
    object !== null &&
    ((object.module === "effect" && object.name === "Layer") ||
      object.module === "effect/Layer" ||
      object.module.startsWith("alchemy"))
  );
};

const isFetchFunction = (node: FunctionThunk) => {
  const { parent } = node;

  return (
    (node.type === "FunctionDeclaration" && node.id?.name === "fetch") ||
    (parent?.type === "VariableDeclarator" &&
      parent.id.type === "Identifier" &&
      parent.id.name === "fetch") ||
    (parent?.type === "Property" && parent.key.type === "Identifier" && parent.key.name === "fetch")
  );
};

const isEffectThunk = (node: FunctionThunk, context: RuleContext) => {
  const { parent } = node;

  return (
    parent?.type === "CallExpression" &&
    (isEffectCall(parent, "gen", context) ||
      (parent.callee.type === "CallExpression" && isEffectCall(parent.callee, "fn", context)) ||
      isEffectCall(parent, "fnUntraced", context))
  );
};

const isSharedConstruction = (node: ESTree.Node, context: RuleContext) => {
  let current: ESTree.Node | null = node.parent;

  while (current !== null) {
    if (current.type === "CallExpression" && isInitializationCall(current, context)) {
      return true;
    }

    if (
      (current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression" ||
        current.type === "ArrowFunctionExpression") &&
      !isEffectThunk(current, context)
    ) {
      if (isFetchFunction(current)) {
        return false;
      }

      const scope = context.sourceCode.getScope(current);

      if (scope.upper?.type !== "module" && scope.upper?.type !== "global") {
        return false;
      }
    }

    current = current.parent;
  }

  return true;
};

const noSharedPendingCache = defineRule({
  create(context) {
    if (!sdkRuntimeSource(sdkRepositoryPath(context.filename))) {
      return {};
    }

    return {
      CallExpression(node) {
        if (
          cacheConstructors.some((name) => isEffectCall(node, name, context)) &&
          isSharedConstruction(node, context)
        ) {
          context.report({ messageId: "pendingCache", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Keep pending request work out of shared initialization caches.",
    },
    messages: {
      pendingCache:
        "Cache completed values only at module or shared Layer initialization scope. Effect.cached* shares pending work across operations. Move the cache into the operation or store completed values; a scoped exception must name its lifetime with a -- reason.",
    },
    type: "problem",
  },
});

const isNodeWithin = (node: ESTree.Node, ancestor: ESTree.Node) => {
  let current: ESTree.Node | null = node;

  while (current !== null) {
    if (current === ancestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
};

const isCapturedValue = (
  expression: ESTree.Expression,
  thunk: FunctionThunk,
  context: RuleContext,
  seen = new Set<Definition["node"]>(),
): boolean => {
  const value = unwrapExpression(expression);

  if (value.type === "Identifier") {
    const definition = declarationOf(value.name, context.sourceCode.getScope(value));

    if (definition === undefined) {
      return true;
    }

    if (seen.has(definition.node)) {
      return false;
    }

    seen.add(definition.node);

    if (!isNodeWithin(definition.node, thunk)) {
      return true;
    }

    if (definition.node.type === "VariableDeclarator") {
      return definition.node.init === null
        ? false
        : isCapturedValue(definition.node.init, thunk, context, seen);
    }

    const defaultedParameter = thunk.params.find(
      (parameter): parameter is AssignmentPatternNode =>
        parameter.type === "AssignmentPattern" &&
        parameter.left.type === "Identifier" &&
        parameter.left.name === value.name,
    );

    return defaultedParameter === undefined
      ? false
      : isCapturedValue(defaultedParameter.right, thunk, context, seen);
  }

  if (value.type === "ThisExpression") {
    return true;
  }

  if (value.type === "MemberExpression") {
    if (value.object.type === "ThisExpression") {
      return true;
    }

    return isCapturedValue(value.object, thunk, context, seen);
  }

  return false;
};

const returnsCapturedHandle = (node: ESTree.Node, context: RuleContext) => {
  if (node.type !== "CallExpression") {
    return false;
  }

  const expression = unwrapExpression(node);

  if (expression.type !== "CallExpression" || !isEffectCall(expression, "sync", context)) {
    return false;
  }

  const [argument] = expression.arguments;

  const thunk =
    argument === undefined || argument.type === "SpreadElement" ? null : unwrapExpression(argument);

  if (
    thunk === null ||
    (thunk.type !== "ArrowFunctionExpression" && thunk.type !== "FunctionExpression") ||
    thunk.body === null
  ) {
    return false;
  }

  if (thunk.body.type !== "BlockStatement") {
    return isCapturedValue(thunk.body, thunk, context);
  }

  const returns = thunk.body.body.filter(
    (statement): statement is ReturnStatementNode => statement.type === "ReturnStatement",
  );

  const [returned] = returns;

  return (
    returns.length === 1 &&
    returned !== undefined &&
    returned.argument !== null &&
    isCapturedValue(returned.argument, thunk, context)
  );
};

const acquireReleaseConstructsInAcquireBody = defineRule({
  create(context) {
    return {
      CallExpression(node) {
        if (!isEffectCall(node, "acquireRelease", context)) {
          return;
        }

        const [acquire] = node.arguments;

        if (acquire === undefined || acquire.type === "SpreadElement") {
          return;
        }

        const expression = unwrapExpression(acquire);

        if (
          isEffectCall(expression, "succeed", context) ||
          returnsCapturedHandle(expression, context)
        ) {
          context.report({ messageId: "eagerAcquire", node: acquire });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Construct a resource inside the Effect.acquireRelease acquire Effect, not before it.",
    },
    messages: {
      eagerAcquire:
        "Build the resource inside acquire (Effect.sync, Effect.tryPromise, or another lazy Effect). Effect.succeed(handle) or Effect.sync(() => handle) creates it before acquire runs, so an interruption in between leaks it.",
    },
    type: "problem",
  },
});

const isModuleScopedVar = (node: ESTree.Node) => {
  let current = node.parent;

  while (current !== null && current.type !== "Program") {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "StaticBlock" ||
      current.type === "TSDeclareFunction" ||
      current.type === "TSModuleBlock"
    ) {
      return false;
    }

    current = current.parent;
  }

  return current?.type === "Program";
};

const noModuleLevelMutableState = defineRule({
  create(context) {
    if (!sdkRuntimeSource(sdkRepositoryPath(context.filename))) {
      return {};
    }

    return {
      VariableDeclaration(node) {
        if (node.kind !== "let" && node.kind !== "var") {
          return;
        }

        const scope = context.sourceCode.getScope(node);

        const moduleScoped =
          node.kind === "let"
            ? scope.type === "module" || scope.type === "global"
            : isModuleScopedVar(node);

        if (moduleScoped) {
          context.report({ messageId: "moduleState", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Keep state out of module-level let and var bindings.",
    },
    messages: {
      moduleState:
        "Module-level let and var are shared by every SDK consumer. Keep mutable state in a Ref acquired inside its owning Layer or operation.",
    },
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "rat-stack-patterns" },
  rules: {
    "acquire-release-constructs-in-acquire-body": acquireReleaseConstructsInAcquireBody,
    "no-module-level-mutable-state": noModuleLevelMutableState,
    "no-shared-pending-cache": noSharedPendingCache,
  },
});
