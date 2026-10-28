// Freezes Promise and Promise.prototype in this realm and in every vm context, as hosts that lock down built-ins in all realms do.
const vm = require("node:vm");
Object.freeze(Promise);
Object.freeze(Promise.prototype);
const createContext = vm.createContext;
vm.createContext = function frozenPromiseCreateContext(...args) {
  const context = createContext.apply(this, args);
  vm.runInContext("Object.freeze(Promise); Object.freeze((async () => {})().constructor.prototype)", context);
  return context;
};
