import { registerHooks } from "node:module";

// `pi install` installs extension packages without their peers, so typebox doesn't resolve outside DM.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === "typebox" || specifier.startsWith("typebox/")) && context.parentURL?.includes("/extensions/dm-mcp-adapter/")) {
      throw Object.assign(new Error(`Cannot find package 'typebox' imported from ${context.parentURL}`), { code: "ERR_MODULE_NOT_FOUND" });
    }
    return nextResolve(specifier, context);
  },
});
